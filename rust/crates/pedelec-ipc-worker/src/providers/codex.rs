//! Codex operations extracted from the Tool-first worker, using the existing Pedelec controller.
use super::common::*;
use crate::{
    artifacts::{sniff_image, ArtifactMeta, ArtifactStage},
    event_sink::{bounded_text, numeric_fields, protocol_traffic, EventSink},
    protocol::{OpenPayload, RehydrateEffort, RehydratePayload, SendPayload},
    tool_trace::{ToolTracer, TraceProvider},
    IpcFailure,
};
use base64::Engine;
use pedelec_runtime::{
    CodexAppServerController, CodexApprovalPolicy, CodexInterruptRequest, CodexReasoningEffort,
    CodexRuntimeEvent, CodexRuntimeLaunchConfig, CodexSandboxMode, CodexSessionConfig,
    CodexTurnConfig, CodexTurnSandboxPolicy, CodexTurnStatus, ProviderRuntimeController,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const MAX_PROTOCOL_RECORDS_PER_TICK: usize = 256;
#[derive(Debug)]
struct SessionState {
    provider_session_id: Option<String>,
    active_turn_id: Option<String>,
}

pub(crate) struct CodexSession {
    workdir: PathBuf,
    model: Option<String>,
    effort: Option<CodexReasoningEffort>,
    host_instructions: String,
    /// Provider shells only get these through the thread config, on every ensure path.
    shell_config: HashMap<String, Value>,
    controller: Arc<CodexAppServerController>,
    state: Arc<Mutex<SessionState>>,
    stop_events: Arc<AtomicBool>,
    event_worker: Option<JoinHandle<()>>,
}

impl CodexSession {
    pub(super) fn open(
        session_id: &str,
        payload: OpenPayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if payload.model.trim().is_empty() {
            return Err(IpcFailure::new("INVALID_INPUT", "model is required"));
        }
        let effort = parse_effort(&payload.effort)?;
        validate_host_instructions(&payload.host_instructions)?;
        let workdir = canonical_workdir(&payload.server_workdir)?;
        let provider = resolve_provider("PEDELEC_CODEX_PATH", "codex").ok_or_else(|| {
            IpcFailure::new("PROVIDER_UNAVAILABLE", "Codex executable is unavailable").retryable()
        })?;
        let stage = ArtifactStage::new(
            session_id,
            payload.artifact_staging_dir.as_deref().map(PathBuf::from),
            events,
        );
        let controller = CodexAppServerController::spawn(cli_launch_config(
            provider.path,
            workdir.clone(),
            !payload.tools.is_empty(),
        )?)
        .map_err(|_| {
            IpcFailure::new(
                "PROVIDER_UNAVAILABLE",
                "Codex app server could not be initialized",
            )
            .retryable()
        })?;

        let state = Arc::new(Mutex::new(SessionState {
            provider_session_id: None,
            active_turn_id: None,
        }));
        let shell_config = cli_shell_config(!payload.tools.is_empty())?;
        let session_config = CodexSessionConfig {
            model: Some(payload.model.clone()),
            effort,
            cwd: workdir.clone(),
            approval_policy: CodexApprovalPolicy::Never,
            sandbox: CodexSandboxMode::ReadOnly,
            developer_instructions: payload.host_instructions.clone(),
            config: shell_config.clone(),
        };
        // The provider thread exists even when the host registered zero tools.
        let created = controller
            .ensure_session(session_id, None, &session_config)
            .map_err(|_| {
                let _ = controller.shutdown();
                IpcFailure::new(
                    "PROVIDER_SESSION_FAILED",
                    "provider session could not be opened",
                )
            })?;
        let provider_session_id = Some(created.provider_thread_id);
        if let Ok(mut current) = state.lock() {
            current.provider_session_id = provider_session_id.clone();
        }
        let stop_events = Arc::new(AtomicBool::new(false));
        let event_worker = spawn_event_worker(
            Arc::clone(&controller),
            session_id.to_string(),
            Arc::clone(&state),
            Arc::clone(&stop_events),
            stage,
            events.clone(),
        )
        .map_err(|_| {
            let _ = controller.shutdown();
            IpcFailure::new("INTERNAL", "provider event worker could not start")
        })?;
        let receipt = json!({
            "provider": "codex",
            "runtimeStarted": true,
            "providerSessionId": provider_session_id,
            "providerVersion": provider.version,
            "capabilities": {
                "open-session": "supported",
                "send": "supported",
                "cancel": "supported",
                "close-session": "supported",
                "resume-provider": "supported",
                "rehydrate-session": "supported",
                "tool-reply": "unsupported",
                "cli-tool-transport": "supported"
            }
        });
        Ok((
            Self {
                workdir,
                model: Some(payload.model),
                effort,
                host_instructions: payload.host_instructions,
                shell_config,
                controller,
                state,
                stop_events,
                event_worker: Some(event_worker),
            },
            receipt,
        ))
    }

    pub(super) fn rehydrate(
        session_id: &str,
        payload: RehydratePayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !valid_provider_session_id(&payload.provider_session_id) {
            return Err(IpcFailure::new(
                "INVALID_INPUT",
                "providerSessionId is invalid",
            ));
        }
        if payload.model.trim().is_empty() || payload.model.len() > 512 {
            return Err(IpcFailure::new("INVALID_INPUT", "model is invalid"));
        }
        let effort = match payload.effort {
            RehydrateEffort::Default => None,
            RehydrateEffort::Low => Some(CodexReasoningEffort::Low),
            RehydrateEffort::Medium => Some(CodexReasoningEffort::Medium),
            RehydrateEffort::High => Some(CodexReasoningEffort::High),
            RehydrateEffort::Xhigh => Some(CodexReasoningEffort::XHigh),
            RehydrateEffort::Max => Some(CodexReasoningEffort::Max),
        };
        validate_host_instructions(&payload.host_instructions)?;
        let workdir = canonical_workdir(&payload.server_workdir)?;
        let provider = resolve_provider("PEDELEC_CODEX_PATH", "codex").ok_or_else(|| {
            IpcFailure::new("PROVIDER_UNAVAILABLE", "Codex executable is unavailable").retryable()
        })?;
        let stage = ArtifactStage::new(
            session_id,
            payload.artifact_staging_dir.as_deref().map(PathBuf::from),
            events,
        );
        let controller = CodexAppServerController::spawn(cli_launch_config(
            provider.path,
            workdir.clone(),
            !payload.tools.is_empty(),
        )?)
        .map_err(|_| {
            IpcFailure::new(
                "PROVIDER_UNAVAILABLE",
                "Codex app server could not be initialized",
            )
            .retryable()
        })?;

        let shell_config = cli_shell_config(!payload.tools.is_empty())?;
        let session_config = CodexSessionConfig {
            model: Some(payload.model.clone()),
            effort,
            cwd: workdir.clone(),
            approval_policy: CodexApprovalPolicy::Never,
            sandbox: CodexSandboxMode::ReadOnly,
            developer_instructions: payload.host_instructions.clone(),
            config: shell_config.clone(),
        };
        let resumed = match controller.ensure_session(
            session_id,
            Some(&payload.provider_session_id),
            &session_config,
        ) {
            Ok(resumed) => resumed,
            Err(_) => {
                let _ = controller.shutdown();
                return Err(IpcFailure::new(
                    "PROVIDER_SESSION_FAILED",
                    "persisted Codex provider session could not be resumed",
                ));
            }
        };
        if resumed.provider_thread_id.as_bytes() != payload.provider_session_id.as_bytes() {
            let _ = controller.shutdown();
            return Err(IpcFailure::new(
                "PROVIDER_SESSION_MISMATCH",
                "resumed provider session did not match the persisted identifier",
            ));
        }

        let state = Arc::new(Mutex::new(SessionState {
            provider_session_id: Some(payload.provider_session_id.clone()),
            active_turn_id: None,
        }));
        let stop_events = Arc::new(AtomicBool::new(false));
        let event_worker = match spawn_event_worker(
            Arc::clone(&controller),
            session_id.to_string(),
            Arc::clone(&state),
            Arc::clone(&stop_events),
            stage,
            events.clone(),
        ) {
            Ok(worker) => worker,
            Err(_) => {
                let _ = controller.shutdown();
                return Err(IpcFailure::new(
                    "INTERNAL",
                    "provider event worker could not start",
                ));
            }
        };

        let receipt = json!({
            "provider": "codex",
            "rehydrated": true,
            "runtimeStarted": true,
            "providerSessionId": resumed.provider_thread_id,
            "providerVersion": provider.version,
            "capabilities": {
                "open-session": "supported",
                "rehydrate-session": "supported",
                "send": "supported",
                "cancel": "supported",
                "close-session": "supported",
                "resume-provider": "supported",
                "rehydrate-session": "supported",
                "tool-reply": "unsupported",
                "cli-tool-transport": "supported"
            }
        });
        Ok((
            Self {
                workdir,
                model: Some(payload.model),
                effort,
                host_instructions: payload.host_instructions,
                shell_config,
                controller,
                state,
                stop_events,
                event_worker: Some(event_worker),
            },
            receipt,
        ))
    }

    pub(super) fn send(
        &mut self,
        session_id: &str,
        payload: SendPayload,
    ) -> Result<Value, IpcFailure> {
        let session = self;
        let provider_session_id = ensure_provider_session(session_id, session, None)?;
        {
            let mut state = session
                .state
                .lock()
                .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?;
            if state.active_turn_id.is_some() {
                return Err(IpcFailure::new(
                    "CONFLICT",
                    "session already has an active turn",
                ));
            }
            state.active_turn_id = Some(payload.turn_id.clone());
        }
        let result = session.controller.start_turn(
            session_id,
            &provider_session_id,
            &payload.turn_id,
            &CodexTurnConfig {
                input: payload.text,
                cwd: session.workdir.clone(),
                model: session.model.clone(),
                effort: session.effort,
                approval_policy: CodexApprovalPolicy::Never,
                sandbox_policy: CodexTurnSandboxPolicy::DangerFullAccess,
            },
        );
        match result {
            Ok(result) => Ok(json!({
                "accepted": true,
                "turnId": payload.turn_id,
                "providerSessionId": provider_session_id,
                "responseReceived": result.response_received,
                "evidenceSeen": result.evidence_seen
            })),
            Err(_) => {
                if let Ok(mut state) = session.state.lock() {
                    if state.active_turn_id.as_deref() == Some(payload.turn_id.as_str()) {
                        state.active_turn_id = None;
                    }
                }
                Err(IpcFailure::new(
                    "TURN_OUTCOME_UNKNOWN",
                    "provider turn outcome is unknown; do not retry automatically",
                ))
            }
        }
    }

    pub(super) fn cancel(&mut self, session_id: &str) -> Result<Value, IpcFailure> {
        let session = self;
        let active_turn_id = session
            .state
            .lock()
            .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?
            .active_turn_id
            .clone()
            .ok_or_else(|| IpcFailure::new("NO_ACTIVE_TURN", "session has no active turn"))?;
        // The provider turn id may not exist yet; a stop must still reach this turn.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match session
                .controller
                .request_interrupt(session_id, &active_turn_id)
            {
                Ok(CodexInterruptRequest::Requested) => break,
                Ok(CodexInterruptRequest::NotReady) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(CodexInterruptRequest::NotReady) | Err(_) => {
                    return Err(IpcFailure::new(
                        "CANCEL_OUTCOME_UNKNOWN",
                        "provider cancellation outcome is unknown; do not retry automatically",
                    ));
                }
            }
        }
        Ok(json!({"cancelled": true, "turnId": active_turn_id}))
    }

    pub(super) fn close(
        mut self,
        session_id: &str,
        events: &EventSink,
    ) -> Result<Value, IpcFailure> {
        let session = &mut self;
        let provider_session_id = session
            .state
            .lock()
            .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?
            .provider_session_id
            .clone();
        let active_turn_id = session
            .state
            .lock()
            .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?
            .active_turn_id
            .clone();
        let end_result = if provider_session_id.is_some() {
            session
                .controller
                .end_session(session_id, active_turn_id.as_deref())
                .map_err(|_| IpcFailure::new("CLEANUP_FAILED", "provider session cleanup failed"))
        } else {
            Ok(())
        };
        session.stop_events.store(true, Ordering::Release);
        let shutdown_result = session
            .controller
            .shutdown()
            .map_err(|_| IpcFailure::new("CLEANUP_FAILED", "provider process cleanup failed"));
        if let Some(worker) = session.event_worker.take() {
            let _ = worker.join();
        }
        end_result?;
        shutdown_result?;
        events
            .emit(session_id, "terminal", json!({"status": "closed"}))
            .map_err(|_| IpcFailure::new("INTERNAL", "terminal event could not be written"))?;
        Ok(json!({"closed": true}))
    }

    pub(super) fn cleanup(mut self, session_id: &str) -> usize {
        let mut errors = 0;
        let session = &mut self;
        let (provider_session_id, active_turn_id) = session
            .state
            .lock()
            .map(|state| {
                (
                    state.provider_session_id.clone(),
                    state.active_turn_id.clone(),
                )
            })
            .unwrap_or((None, None));
        if provider_session_id.is_some()
            && session
                .controller
                .end_session(session_id, active_turn_id.as_deref())
                .is_err()
        {
            errors += 1;
        }
        session.stop_events.store(true, Ordering::Release);
        if session.controller.shutdown().is_err() {
            errors += 1;
        }
        if let Some(worker) = session.event_worker.take() {
            let _ = worker.join();
        }
        errors
    }
    pub(super) fn resume(&self, session_id: &str, persisted_id: &str) -> Result<Value, IpcFailure> {
        let provider_session_id = ensure_provider_session(session_id, self, Some(persisted_id))?;
        Ok(json!({"resumed": true, "providerSessionId": provider_session_id}))
    }
}
fn ensure_provider_session(
    session_id: &str,
    session: &CodexSession,
    persisted_provider_session_id: Option<&str>,
) -> Result<String, IpcFailure> {
    let current = session
        .state
        .lock()
        .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?
        .provider_session_id
        .clone();
    if let Some(current) = current {
        if persisted_provider_session_id.is_some_and(|requested| requested != current) {
            return Err(IpcFailure::new(
                "CONFLICT",
                "session is already attached to a different provider session",
            ));
        }
        return Ok(current);
    }
    let config = CodexSessionConfig {
        model: session.model.clone(),
        effort: session.effort,
        cwd: session.workdir.clone(),
        approval_policy: CodexApprovalPolicy::Never,
        sandbox: CodexSandboxMode::ReadOnly,
        developer_instructions: session.host_instructions.clone(),
        config: session.shell_config.clone(),
    };
    let created = session
        .controller
        .ensure_session(session_id, persisted_provider_session_id, &config)
        .map_err(|_| {
            IpcFailure::new(
                "PROVIDER_SESSION_FAILED",
                "provider session could not be opened or resumed",
            )
        })?;
    let mut state = session
        .state
        .lock()
        .map_err(|_| IpcFailure::new("INTERNAL", "session state is unavailable"))?;
    state.provider_session_id = Some(created.provider_thread_id.clone());
    Ok(created.provider_thread_id)
}

fn spawn_event_worker(
    controller: Arc<CodexAppServerController>,
    session_id: String,
    state: Arc<Mutex<SessionState>>,
    stop: Arc<AtomicBool>,
    stage: ArtifactStage,
    events: EventSink,
) -> io::Result<JoinHandle<()>> {
    let active_turn = {
        let state = Arc::clone(&state);
        move || {
            state
                .lock()
                .ok()
                .and_then(|state| state.active_turn_id.clone())
        }
    };
    thread::Builder::new()
        .name("pedelec-codex-event-forwarder".into())
        .spawn(move || {
            let mut tracer = ToolTracer::new(TraceProvider::Codex);
            loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            if forward_protocol_metadata(&controller, &session_id, &events, &mut tracer, active_turn()).is_err() {
                break;
            }
            let event = controller.recv_event_timeout(Duration::from_millis(200));
            // The frame behind this event was captured first: its tool observations (and any before it)
            // must reach the SDK before the event itself, e.g. a terminal that closes the turn.
            if event.is_ok() && forward_protocol_metadata(&controller, &session_id, &events, &mut tracer, active_turn()).is_err() {
                break;
            }
            match event {
                Ok(CodexRuntimeEvent::TurnStarted {
                    provider_turn_id, ..
                }) => {
                    if events
                        .emit(
                            &session_id,
                            "turn",
                            json!({"type":"started", "turnId": active_turn(), "providerTurnId": provider_turn_id}),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::AssistantDelta { text, .. }) => {
                    let (text, truncated) = bounded_text(text);
                    if events
                        .emit(
                            &session_id,
                            "turn",
                            json!({"type":"assistant-delta", "turnId": active_turn(), "text":text, "truncated":truncated}),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::AssistantMessage { text, .. }) => {
                    let (text, truncated) = bounded_text(text);
                    if events
                        .emit(
                            &session_id,
                            "turn",
                            json!({"type":"assistant-message", "turnId": active_turn(), "text":text, "truncated":truncated}),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::TurnCompleted { status, .. }) => {
                    let turn_id = state
                        .lock()
                        .ok()
                        .and_then(|mut state| state.active_turn_id.take());
                    let status = match status {
                        CodexTurnStatus::Completed => "completed",
                        CodexTurnStatus::Failed => "failed",
                        CodexTurnStatus::Interrupted => "interrupted",
                    };
                    if events
                        .emit(
                            &session_id,
                            "terminal",
                            json!({"turnId": turn_id, "status": status}),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::ProtocolError { .. }) => {
                    if events
                        .emit(
                            &session_id,
                            "provider-error",
                            json!({"code":"PROVIDER_PROTOCOL_ERROR"}),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::Disconnected { .. }) => {
                    if !stop.load(Ordering::Acquire) {
                        if let Ok(mut state) = state.lock() {
                            state.active_turn_id = None;
                        }
                        let _ = events.emit(
                            &session_id,
                            "terminal",
                            json!({"code":"PROVIDER_DISCONNECTED"}),
                        );
                    }
                    break;
                }
                Ok(CodexRuntimeEvent::Stderr { text }) => {
                    // Do not surface provider stderr because it can contain
                    // private paths, account identifiers, or credentials.
                    eprintln!("provider stderr omitted ({} bytes)", text.len());
                }
                Ok(CodexRuntimeEvent::UsageUpdated { usage, .. }) => {
                    if events
                        .emit(&session_id, "usage", numeric_fields(&usage, 0))
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexRuntimeEvent::ImageGeneration {
                    item_id,
                    result,
                    saved_path,
                    mime_type,
                    ..
                }) => {
                    if let Some(turn_id) = active_turn() {
                        stage_image(
                            &stage,
                            &turn_id,
                            &item_id,
                            result.as_deref(),
                            saved_path.as_deref(),
                            mime_type.as_deref(),
                        );
                    }
                }
                Ok(CodexRuntimeEvent::Notification { .. }) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            }
        })
}

/// Upstream `materialize_codex_image`: inline base64 or a Codex-saved file, whose
/// leading bytes must agree with any declared MIME type.
fn stage_image(
    stage: &ArtifactStage,
    turn_id: &str,
    item_id: &str,
    result: Option<&str>,
    saved_path: Option<&Path>,
    declared_mime_type: Option<&str>,
) {
    let meta = |format: (&'static str, &'static str)| {
        let (mime_type, filename) = format;
        declared_mime_type
            .is_none_or(|declared| declared.eq_ignore_ascii_case(mime_type))
            .then_some((mime_type, filename))
    };
    let artifact = |mime_type: &'static str, filename: &'static str| ArtifactMeta {
        turn_id,
        source: "image_generation",
        provider_artifact_id: Some(item_id),
        tool_call_id: None,
        filename,
        mime_type,
    };
    if let Some(encoded) = result {
        let decoded = base64::engine::general_purpose::STANDARD.decode(encoded);
        match decoded.ok().and_then(|bytes| {
            let format = sniff_image(&bytes).and_then(meta)?;
            Some((bytes, format))
        }) {
            Some((bytes, (mime_type, filename))) => {
                stage.bytes(artifact(mime_type, filename), &bytes)
            }
            None => stage.failed(turn_id, "ARTIFACT_INVALID"),
        }
        return;
    }
    let header = saved_path.and_then(|path| {
        let mut header = [0u8; 12];
        let count = File::open(path).ok()?.read(&mut header).ok()?;
        sniff_image(&header[..count]).and_then(meta)
    });
    match (saved_path, header) {
        (Some(path), Some((mime_type, filename))) => {
            stage.file(artifact(mime_type, filename), path)
        }
        _ => stage.failed(turn_id, "ARTIFACT_INVALID"),
    }
}

/// Drains provider RPC traffic as metadata only: message bodies can hold prompts, tool payloads and credentials, so they
/// never cross the IPC boundary. Per-token delta notifications are counted instead of forwarded one by one.
fn forward_protocol_metadata(
    controller: &CodexAppServerController,
    session_id: &str,
    events: &EventSink,
    tracer: &mut ToolTracer,
    turn: Option<String>,
) -> io::Result<()> {
    let mut skipped_deltas = 0u64;
    for _ in 0..MAX_PROTOCOL_RECORDS_PER_TICK {
        let Ok(record) = controller.recv_protocol_traffic_timeout(Duration::ZERO) else {
            break;
        };
        // Tool trace reads every record, independent of the metadata/detail monitoring view.
        // Never returns an error: trace-only failures cannot stop this pump.
        tracer.trace(events, session_id, &record, turn.as_deref());
        match protocol_traffic(&record, skipped_deltas) {
            Some(metadata) => {
                skipped_deltas = 0;
                events.emit(session_id, "provider-rpc", metadata)?;
            }
            None => skipped_deltas = skipped_deltas.saturating_add(1),
        }
    }
    Ok(())
}

pub(super) fn parse_effort(value: &str) -> Result<Option<CodexReasoningEffort>, IpcFailure> {
    match value {
        "default" => Ok(None),
        "low" => Ok(Some(CodexReasoningEffort::Low)),
        "medium" => Ok(Some(CodexReasoningEffort::Medium)),
        "high" => Ok(Some(CodexReasoningEffort::High)),
        "xhigh" => Ok(Some(CodexReasoningEffort::XHigh)),
        "max" => Ok(Some(CodexReasoningEffort::Max)),
        _ => Err(IpcFailure::new("INVALID_INPUT", "effort is unsupported")),
    }
}

/// Codex App Server sanitizes the environment of shell tool subprocesses. Passing
/// CLI PATH only to its parent is insufficient: explicitly allowlist the two
/// session-scoped variables in the shell execution environment as well.
/// The Host may name further variables its tools need there, in a comma-separated list.
const SHELL_ENV_PASSTHROUGH: &str = "PEDELEC_SHELL_ENV_PASSTHROUGH";

fn host_shell_env(names: Option<std::ffi::OsString>) -> serde_json::Map<String, Value> {
    let names = names.and_then(|names| names.into_string().ok()).unwrap_or_default();
    names
        .split(',')
        .filter_map(|name| Some((name.to_string(), Value::from(std::env::var(name).ok()?))))
        .collect()
}

fn cli_shell_config(needs_tools: bool) -> Result<HashMap<String, Value>, IpcFailure> {
    let Some(runtime) = cli_runtime_file(needs_tools)? else {
        return Ok(HashMap::new());
    };
    let path = provider_child_path()
        .into_string()
        .map_err(|_| IpcFailure::new("CLI_UNAVAILABLE", "Session CLI PATH is required"))?;
    let mut set = host_shell_env(std::env::var_os(SHELL_ENV_PASSTHROUGH));
    set.insert("PATH".into(), path.into());
    set.insert("PEDELEC_CORE_IPC_RUNTIME_FILE".into(), runtime.to_string_lossy().into());
    Ok(HashMap::from([(
        "shell_environment_policy".into(),
        json!({ "inherit": "core", "set": set }),
    )]))
}

fn cli_launch_config(
    program: PathBuf,
    cwd: PathBuf,
    needs_tools: bool,
) -> Result<CodexRuntimeLaunchConfig, IpcFailure> {
    let mut config =
        CodexRuntimeLaunchConfig::new(program, cwd).with_env("PATH", provider_child_path());
    config.protocol_logging = false;
    if let Some(runtime) = cli_runtime_file(needs_tools)? {
        config = config.with_env(CLI_RUNTIME_FILE_ENV, runtime);
    }
    Ok(config)
}

#[cfg(test)]
mod role_tool_tests {
    use super::*;

    #[test]
    fn tool_registration_is_role_independent_snapshot() {
        let descriptor = crate::protocol::HostToolDescriptor {
            name: "echo".to_owned(),
            description: "Return the input".to_owned(),
            args_schema: json!({"type":"object","properties":{"value":{"type":"string"}}}),
        };
        assert!(super::super::common::validate_tools(&[descriptor.clone()]).is_ok());
        assert!(super::super::common::validate_tools(&[]).is_ok());
        assert!(super::super::common::validate_tools(&[descriptor.clone(), descriptor]).is_err());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_shell_env_forwards_only_named_set_variables() {
        std::env::set_var("PEDELEC_TEST_FORWARDED", "/a b/c");
        std::env::set_var("PEDELEC_TEST_NOT_NAMED", "no");
        let set = super::host_shell_env(Some("PEDELEC_TEST_FORWARDED,PEDELEC_TEST_UNSET,".into()));
        assert_eq!(set.len(), 1);
        assert_eq!(set["PEDELEC_TEST_FORWARDED"], "/a b/c");
        assert!(super::host_shell_env(None).is_empty());
    }

    use super::*;

    #[test]
    fn effort_and_role_allow_lists_are_explicit() {
        assert!(parse_effort("high").is_ok());
        assert!(parse_effort("unlimited").is_err());
        assert!(validate_host_instructions("The host supplies these instructions.").is_ok());
        assert!(validate_host_instructions(&"x".repeat(65 * 1024)).is_err());
        assert!(validate_reason("done").is_ok());
        assert!(validate_reason(" ").is_err());
    }
}
