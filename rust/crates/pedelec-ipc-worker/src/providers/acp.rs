//! Adapted from Pedelec opencode.rs: provider launch, prompt shaping, permission policy,
//! artifacts, Cursor model/mode/config and extensions. No SharedCoreRuntime/registry.
//! OpenCode and Cursor share only the ACP transport; each has its own launch, bootstrap
//! and auth path below. Host Tools arrive through `pedelec-cli` in their shell (MD19).
use super::common::{
    canonical_workdir, cli_runtime_file, provider_child_path, resolve_provider,
    valid_provider_session_id, validate_host_instructions, CLI_RUNTIME_FILE_ENV,
};
use crate::{
    artifacts::{ArtifactMeta, ArtifactStage},
    event_sink::{bounded_text, numeric_fields, protocol_traffic, EventSink},
    tool_trace::{ToolTracer, TraceProvider},
    protocol::{OpenPayload, RehydratePayload, SendPayload},
    IpcFailure,
};
use pedelec_core::build_persistent_user_prompt_with_bootstrap;
use pedelec_runtime::{
    AcpArtifactSource, AcpAuthentication, AcpCancelRequest, AcpConfigOptionUpdate, AcpController,
    AcpExtensionRequestHandler, AcpLaunchConfig, AcpPermissionDecision, AcpPermissionRequest,
    AcpPermissionResolver, AcpRuntimeEvent, AcpSessionConfig, AcpTurnStatus,
    AcpWorkspacePermissionPolicy, RpcServerRequest,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const OPENCODE_CONFIG_CONTENT: &str = "OPENCODE_CONFIG_CONTENT";
const OPENCODE_PERMISSION: &str = "OPENCODE_PERMISSION";
const STOP_ACK_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Default)]
struct TurnState {
    active: Option<String>,
    stop_deadline: Option<Instant>,
}

/// Session-private OpenCode instruction file. It lives outside the Task workdir, so
/// two sessions in one workspace can never overwrite each other's instructions.
struct InstructionFile {
    directory: PathBuf,
    path: PathBuf,
}
impl InstructionFile {
    fn create(contents: &str) -> Result<Self, IpcFailure> {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let directory =
            env::temp_dir().join(format!("pedelec-opencode-{}-{unique}", std::process::id()));
        let failed = |_| failure("PROVIDER_CONFIG_FAILED");
        #[allow(unused_mut)]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(failed)?;
        let path = directory.join("host-instructions.md");
        if let Err(error) = fs::write(&path, contents) {
            let _ = fs::remove_dir_all(&directory);
            return Err(failed(error));
        }
        Ok(Self { directory, path })
    }
}
impl Drop for InstructionFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

pub(crate) struct AcpSession {
    provider: String,
    id: String,
    provider_id: String,
    instructions: String,
    controller: Arc<AcpController>,
    stop: Arc<AtomicBool>,
    pump: Option<JoinHandle<()>>,
    turn: Arc<Mutex<TurnState>>,
    faulted: Arc<AtomicBool>,
    permissions_enabled: Arc<AtomicBool>,
    _instruction_file: Option<InstructionFile>,
}
pub(crate) fn validate_effort(effort: &str) -> Result<(), IpcFailure> {
    if matches!(
        effort,
        "default" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        Ok(())
    } else {
        Err(failure("INVALID_INPUT"))
    }
}
impl AcpSession {
    pub(crate) fn open(
        id: &str,
        payload: OpenPayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::create(id, payload, None, events)
    }
    pub(crate) fn rehydrate(
        id: &str,
        p: RehydratePayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !valid_provider_session_id(&p.provider_session_id) {
            return Err(failure("INVALID_INPUT"));
        }
        let (open, persisted) = p.into_open();
        Self::create(id, open, Some(persisted), events)
    }
    fn create(
        id: &str,
        p: OpenPayload,
        persisted: Option<String>,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !matches!(p.provider.as_str(), "opencode" | "cursor") || p.model.trim().is_empty() {
            return Err(failure("INVALID_INPUT"));
        }
        validate_effort(&p.effort)?;
        validate_host_instructions(&p.host_instructions)?;
        let workdir = canonical_workdir(&p.server_workdir)?;
        let stage = ArtifactStage::new(
            id,
            p.artifact_staging_dir.as_deref().map(PathBuf::from),
            events,
        );
        let cursor = p.provider == "cursor";
        let resolved = if cursor {
            resolve_provider("PEDELEC_CURSOR_PATH", "cursor-agent")
        } else {
            resolve_provider("PEDELEC_OPENCODE_PATH", "opencode")
        }
        .ok_or_else(|| failure("PROVIDER_UNAVAILABLE"))?;
        let mut launch = AcpLaunchConfig::new(&p.provider, resolved.path, &workdir)
            .arg("acp")
            .with_env("PEDELEC_PROVIDER", p.provider.as_str())
            .with_env("PATH", provider_child_path());
        // ACP agents run their shell tool as their own child, so it inherits this file.
        if let Some(file) = cli_runtime_file(!p.tools.is_empty())? {
            launch = launch.with_env(CLI_RUNTIME_FILE_ENV, file);
        }
        launch.protocol_logging = false;
        let mut instruction_file = None;
        if cursor {
            launch =
                launch.with_client_capabilities(json!({"_meta":{"parameterizedModelPicker":true}}));
            if !cursor_auth_available() {
                launch =
                    launch.with_authentication(AcpAuthentication::MethodId("cursor_login".into()));
            }
        } else {
            let file = if p.host_instructions.trim().is_empty() {
                None
            } else {
                Some(InstructionFile::create(&p.host_instructions)?)
            };
            let config = merge_opencode_config(
                env::var(OPENCODE_CONFIG_CONTENT).ok().as_deref(),
                file.as_ref().map(|file| file.path.as_path()),
            )?;
            launch = launch
                .with_env(OPENCODE_CONFIG_CONTENT, config)
                .with_env(OPENCODE_PERMISSION, opencode_permission_overlay());
            instruction_file = file;
        }
        let permissions_enabled = Arc::new(AtomicBool::new(false));
        let permission_gate = permissions_enabled.clone();
        let bound_id = id.to_string();
        let policy = AcpWorkspacePermissionPolicy::new(&workdir);
        let resolver = Arc::new(move |r: &AcpPermissionRequest| {
            if r.pedelec_thread_id != bound_id || !permission_gate.load(Ordering::Acquire) {
                AcpPermissionDecision::RejectOnce
            } else if is_pedelec_helper_execution(&r.tool_call) {
                AcpPermissionDecision::AllowOnce
            } else {
                policy.resolve(r)
            }
        });
        let extension = if cursor {
            Some(Arc::new(CursorExtensions) as Arc<dyn AcpExtensionRequestHandler>)
        } else {
            None
        };
        let controller = AcpController::spawn_with_extension_handler(launch, resolver, extension)
            .map_err(|_| failure("PROVIDER_UNAVAILABLE"))?;
        let setup = (|| {
            let config = AcpSessionConfig::new(&workdir);
            let provider_id = controller
                .ensure_session(id, persisted.as_deref(), &config)
                .map_err(|_| failure("PROVIDER_SESSION_FAILED"))?;
            if !valid_provider_session_id(&provider_id)
                || persisted.as_ref().is_some_and(|v| v != &provider_id)
            {
                return Err(failure("PROVIDER_SESSION_FAILED"));
            }
            configure(&controller, &provider_id, &p)?;
            Ok::<_, IpcFailure>(provider_id)
        })();
        let provider_id = match setup {
            Ok(v) => v,
            Err(e) => {
                let _ = controller.shutdown();
                return Err(e);
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        let turn = Arc::new(Mutex::new(TurnState::default()));
        let faulted = Arc::new(AtomicBool::new(false));
        let pump = spawn_pump(
            (id.into(), provider_id.clone()),
            TraceProvider::acp(&p.provider),
            controller.clone(),
            stage,
            stop.clone(),
            turn.clone(),
            faulted.clone(),
            permissions_enabled.clone(),
            events.clone(),
        )
        .map_err(|_| {
            let _ = controller.shutdown();
            failure("INTERNAL")
        })?;
        let receipt = json!({"provider":p.provider,"runtimeStarted":true,"rehydrated":persisted.is_some(),"providerSessionId":provider_id,"providerVersion":resolved.version,"protocolVersion":1,"hostTools":true,"capabilities":{
            "open-session":"supported","send":"supported","cancel":"supported","close-session":"supported",
            "resume-provider":if controller.supports_load(){"supported"}else{"unsupported"},
            "rehydrate-session":if controller.supports_load(){"supported"}else{"unsupported"},
            "tool-reply":"unsupported","cli-tool-transport":"supported"
        }});
        Ok((
            Self {
                provider: p.provider,
                id: id.into(),
                provider_id,
                instructions: p.host_instructions,
                controller,
                stop,
                pump: Some(pump),
                turn,
                faulted,
                permissions_enabled,
                _instruction_file: instruction_file,
            },
            receipt,
        ))
    }
    pub(crate) fn send(&mut self, id: &str, p: SendPayload) -> Result<Value, IpcFailure> {
        self.check_id(id)?;
        if p.text.trim().is_empty() || p.text.len() > 512 * 1024 {
            return Err(failure("INVALID_INPUT"));
        }
        if self.faulted.load(Ordering::Acquire) {
            return Err(failure("TURN_OUTCOME_UNKNOWN"));
        }
        {
            let mut turn = self.turn.lock().unwrap();
            if turn.active.is_some() {
                return Err(failure("TURN_OUTCOME_UNKNOWN"));
            }
            turn.active = Some(p.turn_id.clone());
            turn.stop_deadline = None;
        }
        self.permissions_enabled.store(true, Ordering::Release);
        // Upstream: Cursor has no system channel, so its first prompt of a new provider
        // session carries the bootstrap once. A loaded session already holds it.
        let bootstrap = self.provider == "cursor"
            && !self.instructions.trim().is_empty()
            && self.controller.session_needs_bootstrap(&self.provider_id);
        let prompt = if bootstrap {
            build_persistent_user_prompt_with_bootstrap(&self.instructions, &p.text)
        } else {
            p.text
        };
        let prompt = if self.provider == "opencode" && prompt.trim_start().starts_with('/') {
            format!("- {prompt}")
        } else {
            prompt
        };
        if self
            .controller
            .start_turn(id, &self.provider_id, &p.turn_id, &prompt)
            .is_err()
        {
            self.permissions_enabled.store(false, Ordering::Release);
            self.faulted.store(true, Ordering::Release);
            return Err(failure("TURN_OUTCOME_UNKNOWN"));
        }
        if bootstrap {
            self.controller.mark_session_bootstrapped(&self.provider_id);
        }
        Ok(
            json!({"accepted":true,"turnId":p.turn_id,"providerSessionId":self.provider_id,"responseReceived":false,"evidenceSeen":false}),
        )
    }
    /// `session/cancel` keeps the provider session; only the prompt's `stopReason`
    /// reports the result. A stop nobody confirms is retired by the pump's deadline.
    pub(crate) fn cancel(&mut self, id: &str) -> Result<Value, IpcFailure> {
        self.check_id(id)?;
        let turn = self
            .turn
            .lock()
            .unwrap()
            .active
            .clone()
            .ok_or_else(|| failure("NO_ACTIVE_TURN"))?;
        self.permissions_enabled.store(false, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.controller.request_cancel(id, &turn) {
                Ok(AcpCancelRequest::Requested) => break,
                Ok(AcpCancelRequest::NotReady) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(AcpCancelRequest::NotReady) | Err(_) => {
                    self.faulted.store(true, Ordering::Release);
                    self.stop.store(true, Ordering::Release);
                    let _ = self.controller.shutdown();
                    return Err(failure("CANCEL_OUTCOME_UNKNOWN"));
                }
            }
        }
        self.turn.lock().unwrap().stop_deadline = Some(Instant::now() + STOP_ACK_DEADLINE);
        Ok(json!({"cancelled":true,"turnId":turn}))
    }
    pub(crate) fn resume(&self, id: &str, persisted: &str) -> Result<Value, IpcFailure> {
        self.check_id(id)?;
        if persisted != self.provider_id
            || !self.controller.supports_load()
            || !self.controller.is_healthy()
            || self.faulted.load(Ordering::Acquire)
        {
            return Err(failure("PROVIDER_SESSION_FAILED"));
        }
        Ok(json!({"providerSessionId":self.provider_id,"resumed":true}))
    }
    pub(crate) fn close(mut self, id: &str, events: &EventSink) -> Result<Value, IpcFailure> {
        self.check_id(id)?;
        let failures = self.stop_all();
        if failures > 0 {
            return Err(failure("PROVIDER_CLOSE_FAILED"));
        }
        events
            .emit(id, "terminal", json!({"status":"closed"}))
            .map_err(|_| failure("INTERNAL"))?;
        Ok(json!({"closed":true}))
    }
    pub(crate) fn cleanup(mut self, _id: &str) -> usize {
        self.stop_all()
    }
    fn check_id(&self, id: &str) -> Result<(), IpcFailure> {
        if id == self.id {
            Ok(())
        } else {
            Err(failure("INVALID_INPUT"))
        }
    }
    fn stop_all(&mut self) -> usize {
        self.permissions_enabled.store(false, Ordering::Release);
        self.stop.store(true, Ordering::Release);
        let end = self
            .controller
            .cancel_and_detach_session(&self.id, &self.provider_id);
        let shutdown = self.controller.shutdown();
        let joined = self.pump.take().map(|p| p.join().is_ok()).unwrap_or(true);
        usize::from(end.is_err()) + usize::from(shutdown.is_err()) + usize::from(!joined)
    }
}
impl Drop for AcpSession {
    fn drop(&mut self) {
        if self.pump.is_some() {
            let _ = self.stop_all();
        }
    }
}
fn failure(code: &'static str) -> IpcFailure {
    IpcFailure::new(
        code,
        "ACP operation failed; do not retry an unknown outcome",
    )
}
fn cursor_auth_available() -> bool {
    ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]
        .iter()
        .any(|key| env::var(key).is_ok_and(|value| !value.trim().is_empty()))
}
/// Merges into any operator OPENCODE_CONFIG_CONTENT; nothing it holds is replaced.
fn merge_opencode_config(
    existing: Option<&str>,
    file: Option<&Path>,
) -> Result<String, IpcFailure> {
    let invalid = || failure("PROVIDER_CONFIG_FAILED");
    let mut root = match existing {
        Some(value) => serde_json::from_str::<Value>(value).map_err(|_| invalid())?,
        None => json!({}),
    };
    let object = root.as_object_mut().ok_or_else(invalid)?;
    if let Some(file) = file {
        let file = Value::String(file.to_string_lossy().into_owned());
        let list = object
            .entry("instructions")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(invalid)?;
        if !list.contains(&file) {
            list.push(file);
        }
    }
    serde_json::to_string(&root).map_err(|_| invalid())
}
/// Upstream `opencode_permission_overlay`: keep the operator policy and pin only
/// `skill: deny`; an unparsable operator value is passed through untouched.
fn opencode_permission_overlay() -> String {
    let existing = env::var(OPENCODE_PERMISSION).ok();
    let Some(mut value) = existing
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .ok()
        .flatten()
        .and_then(|value| value.as_object().cloned())
        .or_else(|| existing.is_none().then(serde_json::Map::new))
    else {
        return existing.unwrap_or_default();
    };
    value.insert("skill".into(), Value::String("deny".into()));
    Value::Object(value).to_string()
}
fn is_pedelec_helper_execution(tool_call: &Value) -> bool {
    // ACP providers may omit rawInput.command from permission requests. Cursor
    // keeps the command in title and sometimes in nested content text instead.
    if tool_call
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "execute")
    {
        return false;
    }
    let mut descriptions = Vec::new();
    collect_command_descriptions(tool_call, &mut descriptions);
    descriptions
        .into_iter()
        .any(|description| contains_helper_name(description, "pedelec-cli"))
}
fn collect_command_descriptions<'a>(value: &'a Value, descriptions: &mut Vec<&'a str>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(key.as_str(), "command" | "title" | "text") {
                    if let Some(description) = value.as_str() {
                        descriptions.push(description);
                    }
                } else if matches!(key.as_str(), "rawInput" | "content") {
                    collect_command_descriptions(value, descriptions);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_command_descriptions(value, descriptions);
            }
        }
        _ => {}
    }
}
fn contains_helper_name(description: &str, helper: &str) -> bool {
    description.match_indices(helper).any(|(start, _)| {
        let before = description[..start].chars().next_back();
        let after = description[start + helper.len()..].chars().next();
        let name_char =
            |character: char| character.is_ascii_alphanumeric() || matches!(character, '_' | '-');
        before.is_none_or(|character| !name_char(character))
            && after.is_none_or(|character| !name_char(character))
    })
}
struct CursorExtensions;
impl AcpExtensionRequestHandler for CursorExtensions {
    fn handle(&self, r: &RpcServerRequest) -> Option<Value> {
        match r.method.as_str() {
            "cursor/ask_question" => {
                Some(json!({"outcome":{"outcome":"skipped","reason":"No interactive question UI"}}))
            }
            "cursor/create_plan" => {
                Some(json!({"outcome":{"outcome":"rejected","reason":"No plan approval UI"}}))
            }
            _ => None,
        }
    }
}
fn configure(c: &AcpController, id: &str, p: &OpenPayload) -> Result<(), IpcFailure> {
    if p.provider == "cursor" {
        let modes = c.session_modes(id).unwrap_or(json!({}));
        let mode = modes["availableModes"]
            .as_array()
            .and_then(|a| a.iter().find(|v| agent_mode(v)))
            .and_then(|v| v["id"].as_str().or(v["modeId"].as_str()).or(v.as_str()));
        if let Some(mode) = mode {
            c.set_mode(id, mode)
                .map_err(|_| failure("PROVIDER_CONFIG_FAILED"))?;
        } else {
            set_category(c, id, "mode", None, None, true)?;
        }
    }
    if p.model != "default" {
        set_category(c, id, "model", None, Some(&p.model), false)?;
    }
    if p.effort != "default" {
        set_category(
            c,
            id,
            if p.provider == "cursor" {
                "thought_level"
            } else {
                "reasoning_effort"
            },
            None,
            Some(&p.effort),
            false,
        )?;
    }
    // No IPC Cursor-specific DTO. Optional fast setting comes only from trusted host env.
    if p.provider == "cursor" {
        if let Ok(fast) = std::env::var("PEDELEC_CURSOR_FAST") {
            if !matches!(fast.as_str(), "true" | "false") {
                return Err(failure("INVALID_INPUT"));
            }
            set_category(c, id, "model_config", Some("fast"), Some(&fast), false)?;
        }
    }
    Ok(())
}
fn agent_mode(v: &Value) -> bool {
    let label = format!(
        "{} {} {}",
        v["id"]
            .as_str()
            .or(v["value"].as_str())
            .or(v.as_str())
            .unwrap_or_default(),
        v["name"].as_str().unwrap_or_default(),
        v["description"].as_str().unwrap_or_default()
    )
    .to_lowercase();
    ["agent", "full", "tool"].iter().any(|s| label.contains(s))
        && !["ask", "plan", "read-only", "readonly", "read only"]
            .iter()
            .any(|s| label.contains(s))
}
fn set_category(
    c: &AcpController,
    id: &str,
    category: &str,
    required_id: Option<&str>,
    requested: Option<&str>,
    agent: bool,
) -> Result<(), IpcFailure> {
    // Re-read after every change: model selection can replace dependent options.
    let options = c.session_config_options(id).unwrap_or(json!([]));
    let option = options
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|o| o["category"] == category && required_id.is_none_or(|v| o["id"] == v))
        })
        .ok_or_else(|| failure("PROVIDER_CONFIG_FAILED"))?;
    let value = option["options"]
        .as_array()
        .and_then(|a| {
            a.iter().find(|v| {
                if agent {
                    agent_mode(v)
                } else {
                    v["value"]
                        .as_str()
                        .or(v["valueId"].as_str())
                        .or(v["id"].as_str())
                        .or(v.as_str())
                        == requested
                }
            })
        })
        .ok_or_else(|| failure("PROVIDER_CONFIG_FAILED"))?;
    let value = value["value"]
        .as_str()
        .or(value["valueId"].as_str())
        .or(value["id"].as_str())
        .or(value.as_str())
        .ok_or_else(|| failure("PROVIDER_CONFIG_FAILED"))?;
    let config_id = option["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("PROVIDER_CONFIG_FAILED"))?;
    c.set_config_option(
        id,
        &AcpConfigOptionUpdate {
            config_id: config_id.into(),
            value: json!(value),
        },
    )
    .map_err(|_| failure("PROVIDER_CONFIG_FAILED"))?;
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn spawn_pump(
    identity: (String, String),
    trace_provider: TraceProvider,
    c: Arc<AcpController>,
    stage: ArtifactStage,
    stop: Arc<AtomicBool>,
    turn: Arc<Mutex<TurnState>>,
    faulted: Arc<AtomicBool>,
    permissions_enabled: Arc<AtomicBool>,
    events: EventSink,
) -> std::io::Result<JoinHandle<()>> {
    let (id, provider_id) = identity;
    let is_active = {
        let turn = turn.clone();
        move |local: &str| turn.lock().unwrap().active.as_deref() == Some(local)
    };
    thread::Builder::new()
        .name("acp-events".into())
        .spawn(move || {
            let mut tracer = ToolTracer::new(trace_provider);
            let active = |turn: &Mutex<TurnState>| turn.lock().ok().and_then(|t| t.active.clone());
            // Every record feeds the tool trace before the monitor view filters it.
            let drain = |tracer: &mut ToolTracer| -> std::io::Result<()> {
                let current = active(&turn);
                for _ in 0..256 {
                    let Ok(record) = c.recv_protocol_traffic_timeout(Duration::ZERO) else {
                        break;
                    };
                    // Trace-only failures stay inside the tracer; provider-rpc keeps its fault contract.
                    tracer.trace(&events, &id, &record, current.as_deref());
                    if let Some(meta) = protocol_traffic(&record, 0) {
                        events.emit(&id, "provider-rpc", meta)?;
                    }
                }
                Ok(())
            };
            while !stop.load(Ordering::Acquire) {
                let expired = {
                    let current = turn.lock().unwrap();
                    current.active.is_some()
                        && current.stop_deadline.is_some_and(|at| Instant::now() >= at)
                };
                if expired {
                    faulted.store(true, Ordering::Release);
                    let _ = events.emit(
                        &id,
                        "provider-error",
                        json!({"code":"PROVIDER_STOP_UNCONFIRMED"}),
                    );
                    let _ = c.shutdown();
                    break;
                }
                if drain(&mut tracer).is_err() {
                    faulted.store(true, Ordering::Release);
                    return;
                }
                let event = c.recv_event_timeout(Duration::from_millis(10));
                if stop.load(Ordering::Acquire) {
                    break;
                }
                // Tool frames captured before this event reach the SDK before it (e.g. a terminal).
                if event.is_ok() && drain(&mut tracer).is_err() {
                    faulted.store(true, Ordering::Release);
                    return;
                }
                let healthy = !faulted.load(Ordering::Acquire);
                let result = match event {
                    Ok(AcpRuntimeEvent::AssistantDelta {
                        pedelec_thread_id,
                        provider_session_id,
                        local_turn_id,
                        text,
                    }) if pedelec_thread_id == id
                        && provider_session_id == provider_id
                        && is_active(&local_turn_id)
                        && healthy =>
                    {
                        let (text, truncated) = bounded_text(text);
                        events.emit(
                            &id,
                            "turn",
                            json!({"type":"assistant-delta","turnId":local_turn_id,"text":text,"truncated":truncated}),
                        )
                    }
                    Ok(AcpRuntimeEvent::AssistantMessage {
                        pedelec_thread_id,
                        provider_session_id,
                        local_turn_id,
                        text,
                    }) if pedelec_thread_id == id
                        && provider_session_id == provider_id
                        && is_active(&local_turn_id)
                        && healthy =>
                    {
                        let (text, truncated) = bounded_text(text);
                        events.emit(
                            &id,
                            "turn",
                            json!({"type":"assistant-message","turnId":local_turn_id,"text":text,"truncated":truncated}),
                        )
                    }
                    Ok(AcpRuntimeEvent::ProviderArtifact {
                        pedelec_thread_id,
                        provider_session_id,
                        local_turn_id,
                        provider_artifact_id,
                        tool_call_id,
                        source,
                        suggested_filename,
                        mime_type,
                        payload,
                    }) if pedelec_thread_id == id
                        && provider_session_id == provider_id
                        && is_active(&local_turn_id) =>
                    {
                        match (mime_type.as_deref(), payload) {
                            (Some(mime_type), Ok(bytes)) if !mime_type.trim().is_empty() => stage
                                .bytes(
                                    ArtifactMeta {
                                        turn_id: &local_turn_id,
                                        source: match source {
                                            AcpArtifactSource::ProviderArtifact => {
                                                "provider_artifact"
                                            }
                                            AcpArtifactSource::ToolResult => "tool_result",
                                        },
                                        provider_artifact_id: provider_artifact_id.as_deref(),
                                        tool_call_id: tool_call_id.as_deref(),
                                        filename: &suggested_filename,
                                        mime_type,
                                    },
                                    &bytes,
                                ),
                            _ => stage.failed(&local_turn_id, "ARTIFACT_INVALID"),
                        }
                        Ok(())
                    }
                    Ok(AcpRuntimeEvent::Notification {
                        method,
                        params,
                        pedelec_thread_id,
                        local_turn_id: Some(local_turn_id),
                        ..
                    }) if method == "cursor/generate_image"
                        && pedelec_thread_id.as_deref() == Some(id.as_str())
                        && is_active(&local_turn_id) =>
                    {
                        stage_cursor_image(&stage, &local_turn_id, &params);
                        Ok(())
                    }
                    Ok(AcpRuntimeEvent::TurnCompleted {
                        pedelec_thread_id,
                        provider_session_id,
                        local_turn_id,
                        status,
                        ..
                    }) if pedelec_thread_id == id
                        && provider_session_id == provider_id
                        && is_active(&local_turn_id) =>
                    {
                        permissions_enabled.store(false, Ordering::Release);
                        *turn.lock().unwrap() = TurnState::default();
                        let status = if !healthy {
                            "failed"
                        } else {
                            match status {
                                AcpTurnStatus::Completed => "completed",
                                AcpTurnStatus::Failed => "failed",
                                AcpTurnStatus::Interrupted => "interrupted",
                            }
                        };
                        events.emit(&id, "terminal", json!({"turnId":local_turn_id,"status":status}))
                    }
                    Ok(AcpRuntimeEvent::UsageUpdated { usage, .. })
                    | Ok(AcpRuntimeEvent::PromptUsageUpdated { usage, .. }) => {
                        events.emit(&id, "usage", numeric_fields(&usage, 0))
                    }
                    Ok(AcpRuntimeEvent::ProtocolError { .. }) => {
                        faulted.store(true, Ordering::Release);
                        events.emit(
                            &id,
                            "provider-error",
                            json!({"code":"PROVIDER_PROTOCOL_ERROR"}),
                        )
                    }
                    Ok(AcpRuntimeEvent::Disconnected { .. }) => {
                        faulted.store(true, Ordering::Release);
                        let _ =
                            events.emit(&id, "terminal", json!({"code":"PROVIDER_DISCONNECTED"}));
                        break;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        faulted.store(true, Ordering::Release);
                        break;
                    }
                    _ => Ok(()), // stderr, raw notifications and config never enter Monitor.
                };
                if result.is_err() {
                    faulted.store(true, Ordering::Release);
                    break;
                }
            }
        })
}
/// Upstream `cursor/generate_image`: the image is a local file named by the provider.
fn stage_cursor_image(stage: &ArtifactStage, turn_id: &str, params: &Value) {
    let Some(file_path) = params.get("filePath") else {
        return;
    };
    let Some(file_path) = file_path.as_str() else {
        stage.failed(turn_id, "ARTIFACT_INVALID");
        return;
    };
    if file_path.trim().is_empty() {
        return;
    }
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    let path = Path::new(file_path);
    let (Some(tool_call_id), true) = (tool_call_id, path.is_absolute()) else {
        stage.failed(turn_id, "ARTIFACT_INVALID");
        return;
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image");
    stage.file(
        ArtifactMeta {
            turn_id,
            source: "image_generation",
            provider_artifact_id: Some(tool_call_id),
            tool_call_id: Some(tool_call_id),
            filename,
            mime_type,
        },
        path,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_instructions_are_private_to_a_session_and_gone_with_it() {
        let file = InstructionFile::create("host text").unwrap();
        let directory = file.directory.clone();
        assert!(directory.starts_with(env::temp_dir()));
        assert_eq!(fs::read_to_string(&file.path).unwrap(), "host text");
        drop(file);
        assert!(!directory.exists());
    }

    #[test]
    fn helper_permission_needs_an_exact_helper_name_in_an_execute_call() {
        let call = |value: Value| is_pedelec_helper_execution(&value);
        assert!(call(
            json!({"kind":"execute","title":"pedelec-cli --thread-id t tool-spec x"})
        ));
        assert!(call(
            json!({"rawInput":{"command":"pedelec-cli --thread-id t tool-call x '{}'"}})
        ));
        assert!(!call(
            json!({"rawInput":{"command":"other-helper --thread-id t run a.ts"}})
        ));
        assert!(!call(json!({"kind":"read","title":"pedelec-cli"})));
        assert!(!call(
            json!({"kind":"execute","title":"evil-pedelec-cli-wrapper"})
        ));
    }

    #[test]
    fn opencode_config_keeps_operator_values_and_adds_one_instruction_file() {
        let path = Path::new("/private/session/host-instructions.md");
        let merged = merge_opencode_config(
            Some(r#"{"model":"x","instructions":["team.md"]}"#),
            Some(path),
        )
        .unwrap();
        let merged: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(merged["model"], "x");
        assert_eq!(
            merged["instructions"],
            json!(["team.md", "/private/session/host-instructions.md"])
        );
        assert!(merge_opencode_config(Some("[]"), Some(path)).is_err());
        assert_eq!(merge_opencode_config(None, None).unwrap(), "{}");
    }
}
