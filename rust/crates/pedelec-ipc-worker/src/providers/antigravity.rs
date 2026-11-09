//! Adapted from upstream AntigravityRuntimeDispatcher: Full Access launch, workspace
//! agent/hook assets, `--conversation` attach, process-tree stop and artifact hooks.
//! The Controller parses the wire protocol; the SDK owns turn outcomes and ACKs.
//! Excluded: Core reducer/registry, automatic restart after a crash, and synthetic
//! Host tool results. Host Tools arrive through `pedelec-cli` in agy's shell (MD19).
use super::common::{
    canonical_workdir, cli_runtime_file, provider_child_path, resolve_provider,
    valid_provider_session_id, validate_host_instructions, CLI_RUNTIME_FILE_ENV,
};
use crate::{
    artifacts::{ArtifactMeta, ArtifactStage},
    event_sink::{bounded_rpc_value, bounded_text, numeric_fields, protocol_metadata, protocol_traffic, EventSink},
    tool_trace::{ToolTracer, TraceProvider},
    protocol::{OpenPayload, RehydratePayload, SendPayload},
    IpcFailure,
};
use pedelec_core::{build_persistent_prepare_prompt, ensure_antigravity_workspace_assets};
use pedelec_runtime::{
    AntigravityReasoningEffort, AntigravityRuntimeError, AntigravityRuntimeEvent,
    AntigravityRuntimeLaunchConfig, AntigravityStopOutcome, AntigravityStreamController,
    ProviderRuntimeController,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant, UNIX_EPOCH},
};
const PREPARE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_SNAPSHOT_ENTRIES: usize = 4096;
const MAX_SNAPSHOT_DEPTH: usize = 16;
const MAX_PENDING_SNAPSHOTS: usize = 128;
const SNAPSHOT_TTL: Duration = Duration::from_secs(10 * 60);
const SNAPSHOT_SAMPLE_BYTES: usize = 4096;

pub(crate) fn parse_effort(s: &str) -> Result<Option<AntigravityReasoningEffort>, IpcFailure> {
    Ok(match s {
        "default" => None,
        "low" => Some(AntigravityReasoningEffort::Low),
        "medium" => Some(AntigravityReasoningEffort::Medium),
        "high" => Some(AntigravityReasoningEffort::High),
        _ => return Err(failure("UNSUPPORTED_EFFORT")),
    })
}

struct WireState {
    active: Option<String>,
    started: bool,
    retired: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookPayload {
    conversation_id: String,
    #[serde(default)]
    artifact_directory_path: Option<String>,
    tool_call: HookToolCall,
    step_idx: u64,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookToolCall {
    name: String,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSnapshot {
    size: u64,
    modified: Option<(u64, u32)>,
    content_sample: Option<[u8; 32]>,
}

struct PendingSnapshot {
    canonical_root: PathBuf,
    files: BTreeMap<PathBuf, FileSnapshot>,
    captured_at: Instant,
}

pub(crate) struct AntigravitySession {
    id: String,
    provider_id: String,
    controller: Arc<AntigravityStreamController>,
    state: Arc<Mutex<WireState>>,
    stage: ArtifactStage,
    snapshots: Mutex<HashMap<(String, u64), PendingSnapshot>>,
    pump: Option<JoinHandle<()>>,
}
impl AntigravitySession {
    pub(crate) fn open(
        id: &str,
        p: OpenPayload,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::launch(id, p, None, sink)
    }
    /// `--conversation` selects the persisted conversation; only an exact SessionReady
    /// proves it. A different or new conversation is refused, never substituted.
    pub(crate) fn rehydrate(
        id: &str,
        p: RehydratePayload,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !valid_provider_session_id(&p.provider_session_id) {
            return Err(failure("INVALID_INPUT"));
        }
        let (open, persisted) = p.into_open();
        Self::launch(id, open, Some(persisted), sink)
    }
    fn launch(
        id: &str,
        p: OpenPayload,
        persisted: Option<String>,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        let mut launch = validate_open(&p)?;
        let provider = resolve_provider("PEDELEC_ANTIGRAVITY_PATH", "agy")
            .ok_or_else(|| failure("PROVIDER_UNAVAILABLE"))?;
        launch.program = provider.path;
        launch.conversation_id = persisted;
        ensure_antigravity_workspace_assets(&launch.cwd)
            .map_err(|_| failure("PROVIDER_BOOTSTRAP_FAILED"))?;
        let stage = ArtifactStage::new(
            id,
            p.artifact_staging_dir.as_deref().map(PathBuf::from),
            sink,
        );
        let (session, mut receipt) = Self::start_stream(
            id,
            launch,
            &p.host_instructions,
            stage,
            sink,
            PREPARE_TIMEOUT,
        )?;
        receipt["providerVersion"] = json!(provider.version);
        Ok((session, receipt))
    }
    // Compiled only for contract tests; it exercises the same launch path as `open`.
    #[cfg(test)]
    fn open_fake(
        id: &str,
        p: OpenPayload,
        sink: &EventSink,
        program: PathBuf,
        timeout: Duration,
    ) -> Result<(Self, Value), IpcFailure> {
        let mut launch = validate_open(&p)?;
        launch.program = program;
        let stage = ArtifactStage::new(id, None, sink);
        Self::start_stream(id, launch, &p.host_instructions, stage, sink, timeout)
    }
    fn start_stream(
        id: &str,
        launch: AntigravityRuntimeLaunchConfig,
        instructions: &str,
        stage: ArtifactStage,
        sink: &EventSink,
        timeout: Duration,
    ) -> Result<(Self, Value), IpcFailure> {
        let persisted = launch.conversation_id.clone();
        let controller = AntigravityStreamController::spawn(id, launch)
            .map_err(|_| failure("PROVIDER_UNAVAILABLE"))?;
        // This tree is outside the Worker's process group, so the SDK must learn it
        // to stop it if the Worker itself dies.
        let _ = sink.emit(id, "process-tree", json!({"pid": controller.process_id()}));
        let provider_id = match prepare(&controller, instructions, persisted.as_deref(), timeout) {
            Ok(id) => id,
            Err(error) => {
                let _ = controller.shutdown_runtime();
                return Err(error);
            }
        };
        let state = Arc::new(Mutex::new(WireState {
            active: None,
            started: false,
            retired: false,
        }));
        let (c, s, e, sid, pid) = (
            controller.clone(),
            state.clone(),
            sink.clone(),
            id.to_owned(),
            provider_id.clone(),
        );
        let generation = controller.generation();
        let pump = thread::Builder::new()
            .name("pedelec-antigravity-events".into())
            .spawn(move || {
                let mut tracer = ToolTracer::new(TraceProvider::Antigravity);
                loop {
                    let mut state = match s.lock() {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    if state.retired || c.generation() != generation {
                        break;
                    }
                    let turn = state.active.clone();
                    if drain_metadata(&c, &sid, &e, &mut tracer, turn.as_deref()).is_err() {
                        state.retired = true;
                        break;
                    }
                    drop(state);
                    let event = c.recv_event_timeout(Duration::from_millis(25));
                    // Hold this same lock through emit. Cancel cannot return then have
                    // a queued success resurrect the retired session.
                    let mut state = match s.lock() {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    if state.retired {
                        break;
                    }
                    let turn = state.active.clone();
                    if event.is_ok() && drain_metadata(&c, &sid, &e, &mut tracer, turn.as_deref()).is_err() {
                        state.retired = true;
                        break;
                    }
                    match event {
                        Ok(event) => match map_event(event, &mut state, &pid, generation) {
                            Ok(Some((kind, data))) => {
                                // The capability probe's evidence for this turn precedes its terminal.
                                // Trace-only: a failure here is counted, never retires the pump.
                                if kind == "terminal" {
                                    tracer.finish_turn(&e, &sid, turn.as_deref());
                                }
                                if e.emit(&sid, kind, data).is_err() {
                                    state.retired = true;
                                    break;
                                }
                            }
                            Ok(None) => {}
                            Err(code) => {
                                retire(&mut state, &e, &sid, code);
                                break;
                            }
                        },
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => {
                            retire(&mut state, &e, &sid, "PROVIDER_DISCONNECTED");
                            break;
                        }
                    }
                }
                let _ = c.shutdown_runtime();
            })
            .map_err(|_| {
                let _ = controller.shutdown_runtime();
                failure("INTERNAL")
            })?;
        let receipt = json!({"provider":"antigravity", "runtimeStarted":true, "providerSessionId":provider_id,
            "rehydrated":persisted.is_some(),
            "hostTools":true, "capabilities":{"open-session":"supported","send":"supported",
                "cancel":"process-stop","close-session":"supported","resume-provider":"supported",
                "rehydrate-session":"supported","tool-reply":"unsupported","cli-tool-transport":"supported"}});
        Ok((
            Self {
                id: id.into(),
                provider_id,
                controller,
                state,
                stage,
                snapshots: Mutex::new(HashMap::new()),
                pump: Some(pump),
            },
            receipt,
        ))
    }
    pub(crate) fn send(&mut self, id: &str, p: SendPayload) -> Result<Value, IpcFailure> {
        if id != self.id {
            return Err(failure("CONFLICT"));
        }
        if !valid_provider_session_id(&p.turn_id)
            || p.text.trim().is_empty()
            || p.text.len() > 512 * 1024
            || p.text.contains('\0')
        {
            return Err(failure("INVALID_INPUT"));
        }
        let mut s = self.state.lock().map_err(|_| failure("INTERNAL"))?;
        if s.retired || !self.controller.is_healthy() {
            return Err(failure("PROVIDER_SESSION_RETIRED"));
        }
        if s.active.is_some() {
            return Err(failure("CONFLICT"));
        }
        s.active = Some(p.turn_id.clone());
        s.started = false;
        if let Err(error) = self.controller.start_turn(&p.turn_id, &p.text) {
            s.retired = true;
            let _ = self.controller.shutdown_runtime();
            return Err(controller_error(error));
        }
        Ok(json!({"accepted":true,"turnId":p.turn_id,"providerSessionId":self.provider_id}))
    }
    pub(crate) fn resume(&self, id: &str, persisted: &str) -> Result<Value, IpcFailure> {
        if id != self.id {
            return Err(failure("CONFLICT"));
        }
        let retired = self.state.lock().map_err(|_| failure("INTERNAL"))?.retired;
        if persisted != self.provider_id || retired || !self.controller.is_healthy() {
            return Err(failure("PROVIDER_SESSION_MISMATCH"));
        }
        Ok(json!({"resumed":true,"providerSessionId":self.provider_id}))
    }
    /// Headless Antigravity has no in-band stop, so this ends the process tree and
    /// proves it empty. The conversation survives on disk for a later attach.
    pub(crate) fn cancel(&mut self, id: &str) -> Result<Value, IpcFailure> {
        if id != self.id {
            return Err(failure("CONFLICT"));
        }
        let turn = self
            .state
            .lock()
            .map_err(|_| failure("INTERNAL"))?
            .active
            .clone()
            .ok_or_else(|| failure("NO_ACTIVE_TURN"))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let outcome = loop {
            match self.controller.stop_turn(&turn) {
                Ok(AntigravityStopOutcome::NotReady) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                other => break other,
            }
        };
        match outcome {
            Ok(AntigravityStopOutcome::Stopped | AntigravityStopOutcome::AlreadyFinished) => {
                // A successful stop also retires this handle. Otherwise queued
                // terminal frames may race with cancellation on Windows.
                self.state.lock().map_err(|_| failure("INTERNAL"))?.retired = true;
                Ok(
                    json!({"cancelled":true,"turnId":turn,"outcome":"unknown","sessionRetired":true}),
                )
            }
            Ok(AntigravityStopOutcome::NotReady) | Err(_) => {
                self.state.lock().map_err(|_| failure("INTERNAL"))?.retired = true;
                self.controller.retire_after_failed_stop();
                self.join()?;
                Ok(
                    json!({"cancelled":true,"turnId":turn,"outcome":"unknown","sessionRetired":true}),
                )
            }
        }
    }
    pub(crate) fn close(mut self, id: &str, sink: &EventSink) -> Result<Value, IpcFailure> {
        if id != self.id {
            return Err(failure("CONFLICT"));
        }
        if self.stop_runtime() != 0 {
            return Err(failure("PROVIDER_CLEANUP_FAILED"));
        }
        sink.emit(id, "terminal", json!({"status":"closed"}))
            .map_err(|_| failure("INTERNAL"))?;
        Ok(json!({"closed":true}))
    }
    pub(crate) fn cleanup(mut self, _id: &str) -> usize {
        self.stop_runtime()
    }
    fn join(&mut self) -> Result<(), IpcFailure> {
        if let Some(p) = self.pump.take() {
            p.join().map_err(|_| failure("PROVIDER_CLEANUP_FAILED"))?;
        }
        Ok(())
    }
    fn stop_runtime(&mut self) -> usize {
        let mut errors = 0;
        match self.state.lock() {
            Ok(mut s) => s.retired = true,
            Err(_) => errors += 1,
        }
        errors += usize::from(self.controller.shutdown_runtime().is_err());
        errors + usize::from(self.join().is_err())
    }
    /// `pedelec-cli provider-artifact-hook` around `generate_image`: `before` records
    /// the artifact directory, `after` stages what the tool added or changed.
    pub(crate) fn artifact_hook(
        &self,
        id: &str,
        stage: &str,
        payload: Value,
    ) -> Result<Value, IpcFailure> {
        if id != self.id || !matches!(stage, "before" | "after") {
            return Err(failure("INVALID_INPUT"));
        }
        let hook: HookPayload =
            serde_json::from_value(payload).map_err(|_| failure("PROVIDER_ARTIFACT_INVALID"))?;
        if hook.tool_call.name != "generate_image" || hook.conversation_id != self.provider_id {
            return Err(failure("PROVIDER_ARTIFACT_INVALID"));
        }
        let turn = self
            .state
            .lock()
            .map_err(|_| failure("INTERNAL"))?
            .active
            .clone()
            .ok_or_else(|| failure("PROVIDER_ARTIFACT_INVALID"))?;
        let key = (turn.clone(), hook.step_idx);
        let mut snapshots = self.snapshots.lock().map_err(|_| failure("INTERNAL"))?;
        let scan = || {
            let directory = hook
                .artifact_directory_path
                .as_deref()
                .ok_or_else(|| failure("PROVIDER_ARTIFACT_INVALID"))?;
            scan_directory(Path::new(directory)).map_err(|_| {
                self.stage.failed(&turn, "ARTIFACT_SOURCE_UNAVAILABLE");
                failure("PROVIDER_ARTIFACT_INVALID")
            })
        };
        if stage == "before" {
            if snapshots.contains_key(&key) {
                return Ok(json!({"accepted":true}));
            }
            let (canonical_root, files) = scan()?;
            snapshots.retain(|_, snapshot| snapshot.captured_at.elapsed() <= SNAPSHOT_TTL);
            if snapshots.len() >= MAX_PENDING_SNAPSHOTS {
                return Err(failure("PROVIDER_ARTIFACT_INVALID"));
            }
            snapshots.insert(
                key,
                PendingSnapshot {
                    canonical_root,
                    files,
                    captured_at: Instant::now(),
                },
            );
            return Ok(json!({"accepted":true}));
        }
        let before = snapshots.remove(&key);
        drop(snapshots);
        if hook
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
        {
            return Ok(json!({"accepted":true}));
        }
        let before = before.ok_or_else(|| {
            self.stage.failed(&turn, "ARTIFACT_SNAPSHOT_MISSING");
            failure("PROVIDER_ARTIFACT_INVALID")
        })?;
        let (canonical_root, after_files) = scan()?;
        if canonical_root != before.canonical_root {
            self.stage.failed(&turn, "ARTIFACT_DIRECTORY_CHANGED");
            return Err(failure("PROVIDER_ARTIFACT_INVALID"));
        }
        let generated: Vec<_> = after_files
            .iter()
            .filter(|(relative, snapshot)| {
                is_visual(relative) && before.files.get(*relative) != Some(*snapshot)
            })
            .map(|(relative, _)| relative.clone())
            .collect();
        if generated.is_empty() {
            self.stage.failed(&turn, "ARTIFACT_NOT_PRODUCED");
            return Err(failure("PROVIDER_ARTIFACT_INVALID"));
        }
        for (index, relative) in generated.iter().enumerate() {
            let source = safe_source(&canonical_root, relative);
            let details = source
                .as_ref()
                .ok()
                .and_then(|path| Some((path, image_mime(path)?, path.file_name()?.to_str()?)));
            let Some((path, mime_type, filename)) = details else {
                self.stage.failed(&turn, "ARTIFACT_INVALID");
                return Err(failure("PROVIDER_ARTIFACT_INVALID"));
            };
            self.stage.file(
                ArtifactMeta {
                    turn_id: &turn,
                    source: "image_generation",
                    provider_artifact_id: Some(&format!("step-{}-{index}", hook.step_idx)),
                    tool_call_id: hook.tool_call.id.as_deref(),
                    filename,
                    mime_type,
                },
                path,
            );
        }
        Ok(json!({"accepted":true}))
    }
}
impl Drop for AntigravitySession {
    fn drop(&mut self) {
        self.stop_runtime();
    }
}

fn validate_open(p: &OpenPayload) -> Result<AntigravityRuntimeLaunchConfig, IpcFailure> {
    if p.provider != "antigravity"
        || p.model.trim().is_empty()
        || p.model.trim() != p.model
        || p.model.len() > 512
        || p.model.chars().any(char::is_control)
    {
        return Err(failure("INVALID_INPUT"));
    }
    let effort = parse_effort(&p.effort)?;
    validate_host_instructions(&p.host_instructions)?;
    let cwd = canonical_workdir(&p.server_workdir)?;
    let mut launch = AntigravityRuntimeLaunchConfig::new(PathBuf::new(), cwd)
        .with_model(Some(p.model.clone()))
        .with_effort(effort)
        .with_env("PEDELEC_PROVIDER", "antigravity")
        .with_env("PATH", provider_child_path());
    // The native shell and the artifact hooks both run under this child environment.
    if let Some(file) = cli_runtime_file(!p.tools.is_empty())? {
        launch = launch.with_env(CLI_RUNTIME_FILE_ENV, file);
    }
    launch.protocol_logging = false;
    launch.max_frame_bytes = crate::protocol::MAX_FRAME_BYTES;
    Ok(launch)
}
fn prepare(
    c: &AntigravityStreamController,
    instructions: &str,
    persisted: Option<&str>,
    timeout: Duration,
) -> Result<String, IpcFailure> {
    // A resumed conversation already holds its bootstrap.
    let bootstrap = c.needs_bootstrap();
    let host = format!("{instructions}\n");
    c.start_prepare(&build_persistent_prepare_prompt(
        bootstrap.then_some(host.as_str()),
    ))
    .map_err(controller_error)?;
    let deadline = Instant::now() + timeout;
    loop {
        // Do not expose preparation assistant/usage as user-turn output; drain
        // raw traffic so the unbounded controller channel cannot grow here.
        for _ in 0..256 {
            if c.recv_protocol_traffic_timeout(Duration::ZERO).is_err() {
                break;
            }
        }
        if Instant::now() >= deadline {
            return Err(failure("PROVIDER_TIMEOUT"));
        }
        match c.recv_event_timeout(Duration::from_millis(10)) {
            Ok(AntigravityRuntimeEvent::SessionReady { conversation_id }) => {
                if !valid_provider_session_id(&conversation_id)
                    || persisted.is_some_and(|expected| expected != conversation_id)
                {
                    return Err(failure("PROVIDER_SESSION_MISMATCH"));
                }
                if bootstrap {
                    c.mark_bootstrap_sent();
                }
                return Ok(conversation_id);
            }
            Ok(
                AntigravityRuntimeEvent::CumulativeUsageUpdated {
                    local_turn_id: None,
                    ..
                }
                | AntigravityRuntimeEvent::Stderr { .. },
            ) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            _ => return Err(failure("PROVIDER_SESSION_FAILED")),
        }
    }
}
fn retire(s: &mut WireState, sink: &EventSink, id: &str, code: &str) {
    s.retired = true;
    let _ = sink.emit(id, "provider-error", json!({"code":code}));
}
fn map_event(
    event: AntigravityRuntimeEvent,
    s: &mut WireState,
    provider_id: &str,
    generation: u64,
) -> Result<Option<(&'static str, Value)>, &'static str> {
    use AntigravityRuntimeEvent::*;
    if s.retired {
        return Ok(None);
    }
    let turn = s.active.as_deref();
    let is_delta = matches!(&event, AssistantDelta { .. });
    let output = match event {
        Stderr { .. } => None,
        Disconnected { generation: g, .. } if g != generation => None,
        Disconnected { .. } => return Err("PROVIDER_DISCONNECTED"),
        ProtocolError { .. } => return Err("PROVIDER_PROTOCOL_ERROR"),
        SessionReady { conversation_id } if conversation_id == provider_id => None,
        SessionReady { .. } => return Err("PROVIDER_SESSION_MISMATCH"),
        TurnStarted { local_turn_id } if turn == Some(local_turn_id.as_str()) && !s.started => {
            s.started = true;
            Some((
                "turn",
                json!({"type":"started","turnId":local_turn_id,"providerTurnId":local_turn_id}),
            ))
        }
        AssistantDelta {
            local_turn_id,
            text,
        }
        | AssistantMessage {
            local_turn_id,
            text,
        } if turn == Some(local_turn_id.as_str()) && s.started => {
            let (text, truncated) = bounded_text(text);
            Some((
                "turn",
                json!({"type":if is_delta {"assistant-delta"}else{"assistant-message"},"turnId":local_turn_id,"text":text,"truncated":truncated}),
            ))
        }
        UsageUpdated {
            local_turn_id,
            usage,
        } if turn == Some(local_turn_id.as_str()) && s.started => Some((
            "usage",
            json!({"turnId":local_turn_id,"scope":"step","usage":numeric_fields(&usage,0)}),
        )),
        CumulativeUsageUpdated {
            local_turn_id: Some(t),
            usage,
        } if turn == Some(t.as_str()) && s.started => Some((
            "usage",
            json!({"turnId":t,"scope":"conversation","usage":numeric_fields(&usage,0)}),
        )),
        TurnCompleted {
            local_turn_id: Some(t),
            success,
            conversation_id,
            ..
        } if turn == Some(t.as_str()) && s.started => {
            if conversation_id.as_deref() != Some(provider_id) {
                return Err("PROVIDER_SESSION_MISMATCH");
            }
            s.active = None;
            Some((
                "terminal",
                json!({"turnId":t,"status":if success {"completed"} else {"failed"}}),
            ))
        }
        TurnInterrupted {
            local_turn_id,
            conversation_id,
            ..
        } if turn == Some(local_turn_id.as_str()) => {
            if conversation_id.as_deref() != Some(provider_id) {
                return Err("PROVIDER_SESSION_MISMATCH");
            }
            // The controller generation ended with this stop; a later attach resumes it.
            s.active = None;
            s.retired = true;
            Some((
                "terminal",
                json!({"turnId":local_turn_id,"status":"interrupted"}),
            ))
        }
        _ => return Err("PROVIDER_PROTOCOL_ERROR"),
    };
    Ok(output)
}
fn drain_metadata(
    c: &AntigravityStreamController,
    id: &str,
    sink: &EventSink,
    tracer: &mut ToolTracer,
    turn: Option<&str>,
) -> std::io::Result<()> {
    for _ in 0..256 {
        let Ok(r) = c.recv_protocol_traffic_timeout(Duration::ZERO) else {
            break;
        };
        // Never returns an error: trace-only failures cannot stop this pump.
        tracer.trace(sink, id, &r, turn);
        if let Some(metadata) = traffic_view(r) {
            sink.emit(id, "provider-rpc", metadata)?;
        }
    }
    Ok(())
}
// The stream protocol has no method/id fields. Never let an injected
// JSON-RPC-looking field become a monitor label or leak a private path.
// Preserve the metadata-only contract for users that only need safe diagnostic labels.
fn traffic_metadata(mut r: pedelec_runtime::ProtocolTrafficRecord) -> Option<Value> {
    let method = match r.message.get("event").and_then(Value::as_str) {
        Some("step_update") => return None,
        Some("user") => "antigravity/user",
        Some("init") => "antigravity/init",
        Some("result") => "antigravity/result",
        _ => "antigravity/other",
    };
    let bytes = serde_json::to_vec(&r.message).ok()?.len();
    r.message = json!({"method":method});
    let mut metadata = protocol_metadata(&r, 0)?;
    metadata["bytes"] = json!(bytes);
    Some(metadata)
}

// Full, bounded traffic view for the Desktop runtime debugger.
fn traffic_view(mut r: pedelec_runtime::ProtocolTrafficRecord) -> Option<Value> {
    if std::env::var("PEDELEC_MONITOR_DETAILS").as_deref() != Ok("1") {
        return traffic_metadata(r);
    }
    let method = match r.message.get("event").and_then(Value::as_str) {
        Some("step_update") => "antigravity/step_update",
        Some("user") => "antigravity/user",
        Some("init") => "antigravity/init",
        Some("result") => "antigravity/result",
        _ => "antigravity/other",
    };
    let original = r.message.clone();
    let bytes = serde_json::to_vec(&original).ok()?.len();
    r.message = json!({"method":method});
    let mut metadata = protocol_traffic(&r, 0)?;
    metadata["bytes"] = json!(bytes);
    metadata["payload"] = bounded_rpc_value(&original, 0);
    Some(metadata)
}
fn scan_directory(directory: &Path) -> Result<(PathBuf, BTreeMap<PathBuf, FileSnapshot>), ()> {
    if !directory.is_absolute() {
        return Err(());
    }
    let metadata = fs::symlink_metadata(directory).map_err(|_| ())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(());
    }
    let root = directory.canonicalize().map_err(|_| ())?;
    let mut files = BTreeMap::new();
    collect_files(&root, &root, 0, &mut files)?;
    Ok((root, files))
}
fn collect_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut BTreeMap<PathBuf, FileSnapshot>,
) -> Result<(), ()> {
    if depth > MAX_SNAPSHOT_DEPTH {
        return Err(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|_| ())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    entries.sort();
    for path in entries {
        let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let canonical = path.canonicalize().map_err(|_| ())?;
            if canonical.starts_with(root) {
                collect_files(root, &canonical, depth + 1, files)?;
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let canonical = path.canonicalize().map_err(|_| ())?;
        if !canonical.starts_with(root) {
            continue;
        }
        let relative = canonical.strip_prefix(root).map_err(|_| ())?.to_path_buf();
        if files.len() >= MAX_SNAPSHOT_ENTRIES {
            return Err(());
        }
        let content_sample = if is_visual(&relative) {
            Some(sample_identity(&canonical, metadata.len())?)
        } else {
            None
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| (time.as_secs(), time.subsec_nanos()));
        files.insert(
            relative,
            FileSnapshot {
                size: metadata.len(),
                modified,
                content_sample,
            },
        );
    }
    Ok(())
}
fn sample_identity(path: &Path, size: u64) -> Result<[u8; 32], ()> {
    let mut file = File::open(path).map_err(|_| ())?;
    let head_size = size.min(SNAPSHOT_SAMPLE_BYTES as u64) as usize;
    let mut head = vec![0u8; head_size];
    file.read_exact(&mut head).map_err(|_| ())?;
    let mut hash = Sha256::new();
    hash.update(size.to_le_bytes());
    hash.update(&head);
    if size > head_size as u64 {
        file.seek(SeekFrom::End(-(head_size as i64)))
            .map_err(|_| ())?;
        let mut tail = vec![0u8; head_size];
        file.read_exact(&mut tail).map_err(|_| ())?;
        hash.update(&tail);
    }
    Ok(hash.finalize().into())
}
fn is_visual(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp"
            )
        })
}
fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let mut header = [0u8; 12];
    let count = File::open(path).ok()?.read(&mut header).ok()?;
    let bytes = &header[..count];
    match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
        "webp" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Some("image/webp")
        }
        _ => None,
    }
}
/// Walks each component again: the tree may have changed since the snapshot.
fn safe_source(root: &Path, relative: &Path) -> Result<PathBuf, ()> {
    let components: Vec<_> = relative.components().collect();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(());
    }
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|_| ())?;
        if metadata.file_type().is_symlink()
            || (index + 1 < components.len() && !metadata.is_dir())
            || (index + 1 == components.len() && !metadata.is_file())
        {
            return Err(());
        }
    }
    let canonical = current.canonicalize().map_err(|_| ())?;
    if canonical.starts_with(root) {
        Ok(canonical)
    } else {
        Err(())
    }
}
fn controller_error(error: AntigravityRuntimeError) -> IpcFailure {
    failure(match error {
        AntigravityRuntimeError::Busy => "CONFLICT",
        AntigravityRuntimeError::ShuttingDown => "PROVIDER_SESSION_RETIRED",
        AntigravityRuntimeError::Write(_)
        | AntigravityRuntimeError::RuntimeStart(_)
        | AntigravityRuntimeError::StopUnconfirmed(_) => "PROVIDER_OUTCOME_UNKNOWN",
    })
}
fn failure(code: &'static str) -> IpcFailure {
    IpcFailure::new(code, "Antigravity provider operation failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        fs,
        io::{self, BufWriter},
    };
    use tempfile::{tempdir, TempDir};
    struct Fake {
        root: TempDir,
        cwd: PathBuf,
        program: PathBuf,
        events: EventSink,
    }
    impl Fake {
        fn new() -> Self {
            let root = tempdir().unwrap();
            let cwd = root.path().join("work");
            fs::create_dir(&cwd).unwrap();
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fake_antigravity.py");
            #[cfg(unix)]
            let program = {
                use std::os::unix::fs::PermissionsExt;
                let path = root.path().join("agy");
                fs::write(
                    &path,
                    format!(
                        "#!/bin/sh\nexec python3 '{}' '{}' \"$@\"\n",
                        script.display(),
                        root.path().display()
                    ),
                )
                .unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
                path
            };
            #[cfg(windows)]
            let program = {
                let path = root.path().join("agy.cmd");
                fs::write(
                    &path,
                    format!(
                        "@echo off\r\npython -X utf8 \"{}\" \"{}\" %*\r\n",
                        script.display(),
                        root.path().display()
                    ),
                )
                .unwrap();
                path
            };
            Self {
                root,
                cwd,
                program,
                events: EventSink {
                    output: Arc::new(Mutex::new(BufWriter::new(io::stdout()))),
                    sequences: Arc::new(Mutex::new(HashMap::new())),
                },
            }
        }
        fn payload(&self, instructions: &str) -> OpenPayload {
            serde_json::from_value(json!({"provider":"antigravity","model":"gemini-test","effort":"high",
                "serverWorkdir":self.cwd,"hostInstructions":instructions,"tools":[]})).unwrap()
        }
        fn sink(&self) -> EventSink {
            self.events.clone()
        }
        fn open(&self, instructions: &str) -> Result<(AntigravitySession, Value), IpcFailure> {
            AntigravitySession::open_fake(
                "s",
                self.payload(instructions),
                &self.sink(),
                self.program.clone(),
                Duration::from_secs(20),
            )
        }
        fn frames(&self) -> Vec<Value> {
            fs::read_to_string(self.root.path().join("stdin.jsonl"))
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }
    fn send(s: &mut AntigravitySession, text: &str) -> Result<Value, IpcFailure> {
        s.send(
            "s",
            SendPayload {
                turn_id: "turn-1".into(),
                text: text.into(),
            },
        )
    }
    fn wait(s: &AntigravitySession, retired: bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            {
                let state = s.state.lock().unwrap();
                if (retired && state.retired) || (!retired && state.active.is_none()) {
                    return;
                }
            }
            assert!(Instant::now() < deadline, "event pump deadline");
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn ag_a01_bootstrap_once_send_complete_close_no_workspace_residue() {
        let f = Fake::new();
        fs::create_dir(f.cwd.join(".agents")).unwrap();
        let hooks = f.cwd.join(".agents/hooks.json");
        fs::write(&hooks, "{\"host-owned\":true}").unwrap();
        fs::write(f.cwd.join("source.txt"), "host source").unwrap();
        let (mut s, receipt) = f.open("HOST EXACT 指令").unwrap();
        assert_eq!(receipt["hostTools"], true);
        assert_eq!(receipt["capabilities"]["cli-tool-transport"], "supported");
        assert!(!s.controller.needs_bootstrap());
        assert_eq!(f.frames().len(), 1);
        assert!(f.frames()[0]["message"]["content"]
            .as_str()
            .unwrap()
            .contains("HOST EXACT 指令"));
        assert_eq!(send(&mut s, "hello").unwrap()["accepted"], true);
        wait(&s, false);
        send(&mut s, "second").unwrap();
        wait(&s, false);
        assert_eq!(f.frames().len(), 3);
        assert_eq!(f.frames()[1]["message"]["content"], "hello");
        assert_eq!(f.frames()[2]["message"]["content"], "second");
        let launch: Value =
            serde_json::from_slice(&fs::read(f.root.path().join("launch.json")).unwrap()).unwrap();
        let args = launch["args"].to_string();
        assert!(args.contains("--agent") && args.contains("pedelec-runtime"));
        assert!(args.contains("--dangerously-skip-permissions"));
        assert!(args.contains("accept-edits"));
        assert!(!args.contains("--sandbox") && !args.contains("\"plan\""));
        assert!(args.contains("gemini-test") && args.contains("high"));
        s.close("s", &f.sink()).unwrap();
        assert_eq!(fs::read_to_string(hooks).unwrap(), "{\"host-owned\":true}");
        assert_eq!(
            fs::read_to_string(f.cwd.join("source.txt")).unwrap(),
            "host source"
        );
        assert!(!f.cwd.join(".pedelec-runtime").exists());
        assert!(!f.cwd.join(".agents/agents").exists());
        assert_eq!(fs::read_dir(&f.cwd).unwrap().count(), 2);
    }
    /// 01A P1-1: trace-only parse, emit and gap-emit failures never retire the Antigravity pump.
    /// (Debug-only `PEDELEC_TOOL_TRACE_FAULT`; the tracer reads it when the pump starts.)
    #[test]
    fn ag_trace_faults_never_retire_the_pump() {
        for faults in ["parse", "emit", "emit,gap", "parse,emit,gap"] {
            std::env::set_var("PEDELEC_TOOL_TRACE_FAULT", faults);
            let f = Fake::new();
            let (mut s, _) = f.open("").unwrap();
            assert_eq!(send(&mut s, "hello").unwrap()["accepted"], true, "{faults}");
            wait(&s, false);
            assert!(!s.state.lock().unwrap().retired, "{faults}: pump retired by a trace fault");
            assert_eq!(send(&mut s, "second").unwrap()["accepted"], true, "{faults}");
            wait(&s, false);
            assert!(!s.state.lock().unwrap().retired, "{faults}");
            s.close("s", &f.sink()).unwrap();
        }
        std::env::remove_var("PEDELEC_TOOL_TRACE_FAULT");
    }
    #[test]
    fn ag_a02_prepare_failure_early_events_wrong_id_crash_eof_are_fatal() {
        for mode in ["FAIL", "EARLY_RESULT", "WRONG_ID", "CRASH", "EOF_PARTIAL"] {
            let f = Fake::new();
            assert!(f.open(mode).is_err(), "prepare {mode}");
        }
        for mode in ["WRONG_ID", "CRASH", "EOF_PARTIAL", "DUPLICATE"] {
            let f = Fake::new();
            let (mut s, _) = f.open("").unwrap();
            send(&mut s, mode).unwrap();
            wait(&s, true);
            assert_eq!(
                send(&mut s, "no retry").unwrap_err().code,
                "PROVIDER_SESSION_RETIRED"
            );
            assert_eq!(s.cleanup("s"), 0);
        }
    }
    #[test]
    fn ag_a03_no_silent_effort_model_attach_or_tool_fallback() {
        for effort in ["xhigh", "max", " high", "unlimited", ""] {
            assert!(parse_effort(effort).is_err());
        }
        for effort in ["default", "low", "medium", "high"] {
            assert!(parse_effort(effort).is_ok());
        }
        let f = Fake::new();
        let mut p = f.payload("");
        p.model = " gemini".into();
        assert!(validate_open(&p).is_err());
        let mut p = f.payload("");
        p.tools = vec![crate::protocol::HostToolDescriptor {
            name: "any-host-tool".into(),
            description: "test".into(),
            args_schema: json!({"type":"object"}),
        }];
        // Use a native absolute path on both Windows and POSIX runners.
        std::env::set_var(CLI_RUNTIME_FILE_ENV, f.root.path().join("runtime.json"));
        assert!(validate_open(&p).is_ok());
        std::env::remove_var(CLI_RUNTIME_FILE_ENV);
        let (s, _) = f.open("").unwrap();
        assert_eq!(s.resume("s", "ag-fake-1").unwrap()["resumed"], true);
        assert_eq!(
            s.resume("s", "another-conversation").unwrap_err().code,
            "PROVIDER_SESSION_MISMATCH"
        );
        assert_eq!(s.cleanup("s"), 0);
    }
    #[test]
    fn ag_a04_cancel_stops_process_tree_retires_and_does_not_rollback() {
        let f = Fake::new();
        let (mut s, _) = f.open("").unwrap();
        let pid = s.controller.process_id();
        send(&mut s, "HANG").unwrap();
        let child = f.root.path().join("child.pid");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !child.exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let receipt = s.cancel("s").unwrap();
        assert_eq!(receipt["outcome"], "unknown");
        assert_eq!(receipt["sessionRetired"], true);
        assert_eq!(
            send(&mut s, "no next turn").unwrap_err().code,
            "PROVIDER_SESSION_RETIRED"
        );
        #[cfg(unix)]
        {
            for p in [pid.to_string(), fs::read_to_string(child).unwrap()] {
                assert_stopped(&p);
            }
        }
        assert_eq!(s.cleanup("s"), 0);
    }
    #[test]
    fn ag_prepare_timeout_cleans_up_and_a_long_turn_is_not_cut_short() {
        let f = Fake::new();
        let error = AntigravitySession::open_fake(
            "s",
            f.payload("HANG"),
            &f.sink(),
            f.program.clone(),
            Duration::from_millis(150),
        );
        assert!(matches!(
            error,
            Err(IpcFailure {
                code: "PROVIDER_TIMEOUT",
                ..
            })
        ));
        let f = Fake::new();
        let (mut s, _) = f.open("").unwrap();
        send(&mut s, "HANG").unwrap();
        thread::sleep(Duration::from_millis(150));
        assert!(!s.state.lock().unwrap().retired);
        assert_eq!(s.cleanup("s"), 0);
    }
    #[test]
    fn ag_event_ordering_generation_and_redaction() {
        let mut s = WireState {
            active: Some("t".into()),
            started: false,
            retired: false,
        };
        let delta = || AntigravityRuntimeEvent::AssistantDelta {
            local_turn_id: "t".into(),
            text: "secret assistant".into(),
        };
        assert_eq!(
            map_event(delta(), &mut s, "c", 7).unwrap_err(),
            "PROVIDER_PROTOCOL_ERROR"
        );
        let started = map_event(
            AntigravityRuntimeEvent::TurnStarted {
                local_turn_id: "t".into(),
            },
            &mut s,
            "c",
            7,
        )
        .unwrap()
        .unwrap();
        assert_eq!(started.1["type"], "started");
        assert_eq!(
            map_event(delta(), &mut s, "c", 7).unwrap().unwrap().1["type"],
            "assistant-delta"
        );
        assert!(map_event(
            AntigravityRuntimeEvent::Disconnected {
                generation: 6,
                pid: 1,
                reason: "secret".into()
            },
            &mut s,
            "c",
            7
        )
        .unwrap()
        .is_none());
        let usage = map_event(
            AntigravityRuntimeEvent::UsageUpdated {
                local_turn_id: "t".into(),
                usage: json!({"tokens":3,"secret":"not-monitor"}),
            },
            &mut s,
            "c",
            7,
        )
        .unwrap()
        .unwrap()
        .1;
        assert!(!usage.to_string().contains("not-monitor"));
        assert_eq!(usage["usage"]["tokens"], 3);
        assert!(map_event(
            AntigravityRuntimeEvent::AssistantMessage {
                local_turn_id: "wrong-turn".into(),
                text: "x".into()
            },
            &mut s,
            "c",
            7
        )
        .is_err());
        s.retired = true;
        assert!(map_event(delta(), &mut s, "c", 7).unwrap().is_none());
    }
    #[test]
    fn ag_late_terminal_after_cancel_cannot_revive_session() {
        let f = Fake::new();
        let (mut s, _) = f.open("").unwrap();
        send(&mut s, "DELAY").unwrap();
        s.cancel("s").unwrap();
        wait(&s, true);
        assert!(send(&mut s, "next").is_err());
        assert_eq!(s.cleanup("s"), 0);
    }
    #[test]
    #[ignore = "requires installed/authenticated agy; uses disposable workspace and real inference"]
    fn ag_real_cli_prepare_turn_cancel_cleanup() {
        let f = Fake::new();
        let program = resolve_provider("PEDELEC_ANTIGRAVITY_PATH", "agy")
            .expect("installed trusted agy")
            .path;
        // No exact model is invented. This connectivity probe uses CLI default;
        // model/effort preservation remains separately tested with the fake.
        let mut launch = AntigravityRuntimeLaunchConfig::new(program, &f.cwd);
        launch.protocol_logging = false;
        launch.max_frame_bytes = crate::protocol::MAX_FRAME_BYTES;
        let sink = f.sink();
        let stage = ArtifactStage::new("s", None, &sink);
        let (mut session, receipt) = AntigravitySession::start_stream(
            "s", launch, "Read-only connectivity probe. Do not call tools, run commands, read or modify files. Reply briefly.",
            stage, &sink, PREPARE_TIMEOUT).expect("real CLI prepare");
        assert!(!session.controller.needs_bootstrap());
        assert_eq!(receipt["hostTools"], true);
        assert_eq!(receipt["capabilities"]["cli-tool-transport"], "supported");
        send(&mut session, "Without using tools or files, reply only OK.").unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let s = session.state.lock().unwrap();
            assert!(!s.retired, "real stream retired");
            if s.active.is_none() {
                break;
            }
            drop(s);
            assert!(Instant::now() < deadline, "real turn timeout");
            thread::sleep(Duration::from_millis(25));
        }
        send(
            &mut session,
            "Without tools or files, count from 1 to 5000.",
        )
        .unwrap();
        assert_eq!(session.cancel("s").unwrap()["outcome"], "unknown");
        assert!(send(&mut session, "no continuation").is_err());
        assert_eq!(session.cleanup("s"), 0);
        assert_eq!(
            fs::read_dir(&f.cwd).unwrap().count(),
            0,
            "unexpected real CLI workdir residue"
        );
    }
    #[cfg(unix)]
    fn assert_stopped(pid: &str) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let output = std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            if !output.status.success()
                || String::from_utf8_lossy(&output.stdout)
                    .trim_start()
                    .starts_with('Z')
            {
                return;
            }
            assert!(Instant::now() < deadline, "process {pid} is still running");
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn ag_crash_and_natural_exit_cleanup_descendants_without_touching_other_session() {
        let other = Fake::new();
        let (mut live, _) = other.open("").unwrap();
        for mode in ["CRASH_TREE", "TREE EXIT_AFTER"] {
            let f = Fake::new();
            let (mut s, _) = f.open("").unwrap();
            send(&mut s, mode).unwrap();
            wait(&s, true);
            assert_eq!(s.cleanup("s"), 0);
            #[cfg(unix)]
            assert_stopped(&fs::read_to_string(f.root.path().join("child.pid")).unwrap());
        }
        send(&mut live, "still live").unwrap();
        wait(&live, false);
        assert_eq!(live.cleanup("s"), 0);
    }
    #[test]
    #[cfg(unix)]
    fn ag_a05_symlink_hook_and_log_locations_are_never_written() {
        use std::os::unix::fs::symlink;
        let f = Fake::new();
        let outside = f.root.path().join("host-owned");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("hooks.json"), "host bytes").unwrap();
        symlink(&outside, f.cwd.join(".agents")).unwrap();
        symlink(&outside, f.cwd.join(".pedelec-runtime")).unwrap();
        let (s, _) = f.open("no file effects").unwrap();
        assert_eq!(s.cleanup("s"), 0);
        assert_eq!(
            fs::read_to_string(outside.join("hooks.json")).unwrap(),
            "host bytes"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        let bad = f.root.path().join("symlink-workdir");
        symlink(&f.cwd, &bad).unwrap();
        let mut p = f.payload("");
        p.server_workdir = bad.to_string_lossy().into_owned();
        assert_eq!(validate_open(&p).unwrap_err().code, "INVALID_INPUT");
    }
    #[test]
    fn ag_b04_injected_protocol_fields_cannot_leak_monitor_content() {
        let r = pedelec_runtime::ProtocolTrafficRecord {
            ts: "2026-11-04T00:00:00Z".into(),
            direction: "provider_to_client".into(),
            kind: "event".into(),
            thread_id: Some("s".into()),
            unmatched: false,
            message: json!({"event":"result","method":"/private/secret","id":"private-token","error":{"message":"tool-result"},"result":{"response":"prompt-secret"}}),
        };
        let metadata = traffic_metadata(r).unwrap();
        assert_eq!(metadata["method"], "antigravity/result");
        for secret in ["/private", "private-token", "tool-result", "prompt-secret"] {
            assert!(!metadata.to_string().contains(secret));
        }
    }
}
