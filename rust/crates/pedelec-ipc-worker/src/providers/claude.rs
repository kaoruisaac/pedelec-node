//! Claude-specific migration of Pedelec ClaudeRuntimeDispatcher: Full Access launch,
//! user settings/tools/MCP untouched. The stream controller owns parsing; the SDK owns
//! outcomes. Host Tools arrive through `pedelec-cli` in Claude's own shell (MD19).
use super::common::{
    canonical_workdir, cli_runtime_file, provider_child_path, resolve_provider,
    valid_provider_session_id, validate_host_instructions, CLI_RUNTIME_FILE_ENV,
};
use crate::{
    artifacts::{extension_for_mime, ArtifactMeta, ArtifactStage},
    event_sink::{bounded_text, numeric_fields, protocol_traffic, EventSink},
    tool_trace::{ToolTracer, TraceProvider},
    protocol::{OpenPayload, RehydratePayload, SendPayload},
    IpcFailure,
};
use pedelec_runtime::{
    ClaudeArtifactSource, ClaudeInterruptRequest, ClaudeReasoningEffort, ClaudeRuntimeEvent,
    ClaudeRuntimeLaunchConfig, ClaudeStreamController, ProviderRuntimeController,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const PREPARE: &str = "[Session Preparation]\nInitialize this provider conversation for subsequent Pedelec user turns. Do not call tools or modify files. A brief acknowledgement is sufficient.";
const STOP_ACK_DEADLINE: Duration = Duration::from_secs(10);

struct WireState {
    active: Option<String>,
    retired: bool,
    started: bool,
    message: String,
    last_message: Option<String>,
    usage: bool,
    stop_deadline: Option<Instant>,
}
pub(crate) struct ClaudeSession {
    id: String,
    provider_id: String,
    controller: Arc<ClaudeStreamController>,
    state: Arc<Mutex<WireState>>,
    stop: Arc<AtomicBool>,
    pump: Option<JoinHandle<()>>,
}
pub(crate) fn parse_effort(s: &str) -> Result<Option<ClaudeReasoningEffort>, IpcFailure> {
    Ok(match s {
        "default" => None,
        "low" => Some(ClaudeReasoningEffort::Low),
        "medium" => Some(ClaudeReasoningEffort::Medium),
        "high" => Some(ClaudeReasoningEffort::High),
        "xhigh" => Some(ClaudeReasoningEffort::XHigh),
        "max" => Some(ClaudeReasoningEffort::Max),
        _ => return Err(failure("INVALID_INPUT")),
    })
}
/// A managed policy or root account refuses skip-permissions at startup. That must
/// surface as its own failure; Claude is never silently relaunched with fewer rights.
fn refuses_full_access(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.contains("dangerously-skip-permissions")
        || text.contains("bypasspermissions")
        || text.contains("bypass permissions")
}
impl ClaudeSession {
    pub(crate) fn open(
        id: &str,
        p: OpenPayload,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::create(id, p, None, sink)
    }
    pub(crate) fn rehydrate(
        id: &str,
        p: RehydratePayload,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !valid_provider_session_id(&p.provider_session_id) {
            return Err(failure("INVALID_INPUT"));
        }
        let (open, persisted) = p.into_open();
        Self::create(id, open, Some(persisted), sink)
    }
    fn create(
        id: &str,
        p: OpenPayload,
        persisted: Option<String>,
        sink: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if p.provider != "claude"
            || p.model.trim().is_empty()
            || p.model.len() > 512
            || p.model.contains('\0')
        {
            return Err(failure("INVALID_INPUT"));
        }
        let effort = parse_effort(&p.effort)?;
        validate_host_instructions(&p.host_instructions)?;
        let cwd = canonical_workdir(&p.server_workdir)?;
        let stage = ArtifactStage::new(
            id,
            p.artifact_staging_dir
                .as_deref()
                .map(std::path::PathBuf::from),
            sink,
        );
        let provider = resolve_provider("PEDELEC_CLAUDE_PATH", "claude")
            .ok_or_else(|| failure("PROVIDER_UNAVAILABLE"))?;
        // Trusted launcher discovery, never a client-supplied command or arguments.
        verify_cli(&provider.path)?;
        // Claude's Bash tool inherits this child environment; the prompt never carries it.
        let runtime_file = cli_runtime_file(!p.tools.is_empty())?;
        let mut launch = ClaudeRuntimeLaunchConfig::new(provider.path, cwd)
            .with_model(Some(p.model))
            .with_effort(effort)
            .with_resume_session_id(persisted.clone())
            .with_host_instructions(p.host_instructions)
            .with_env("PEDELEC_PROVIDER", "claude")
            .with_env("PATH", provider_child_path());
        if let Some(file) = runtime_file {
            launch = launch.with_env(CLI_RUNTIME_FILE_ENV, file);
        }
        launch.protocol_logging = false;
        let controller = ClaudeStreamController::spawn(id, launch)
            .map_err(|_| failure("PROVIDER_UNAVAILABLE"))?;
        // Prepare has no SDK turn ID and never emits user chat or a terminal.
        let prepared = (|| {
            controller
                .start_prepare(PREPARE)
                .map_err(|_| failure("PROVIDER_SESSION_FAILED"))?;
            let deadline = Instant::now() + Duration::from_secs(90);
            let mut refused = false;
            let startup_failure = |refused: bool| {
                failure(if refused {
                    "PROVIDER_POLICY_REFUSED"
                } else {
                    "PROVIDER_SESSION_FAILED"
                })
            };
            loop {
                drain_metadata(&controller, id, sink, None).map_err(|_| failure("INTERNAL"))?;
                if Instant::now() >= deadline {
                    return Err(startup_failure(refused));
                }
                match controller.recv_event_timeout(Duration::from_millis(100)) {
                    Ok(ClaudeRuntimeEvent::SessionReady { session_id }) => {
                        if !valid_provider_session_id(&session_id)
                            || persisted.as_ref().is_some_and(|p| p != &session_id)
                        {
                            return Err(failure("PROVIDER_SESSION_MISMATCH"));
                        }
                        return Ok(session_id);
                    }
                    Ok(ClaudeRuntimeEvent::Stderr { text }) => {
                        refused |= refuses_full_access(&text);
                    }
                    Ok(ClaudeRuntimeEvent::TurnCompleted { error, .. }) => {
                        refused |=
                            error.is_some_and(|error| refuses_full_access(&error.to_string()));
                        return Err(startup_failure(refused));
                    }
                    Ok(
                        ClaudeRuntimeEvent::ProtocolError { .. }
                        | ClaudeRuntimeEvent::Disconnected { .. },
                    ) => return Err(startup_failure(refused)),
                    Ok(ClaudeRuntimeEvent::UsageUpdated { usage, .. }) => {
                        let _ = sink.emit(id, "usage", numeric_fields(&usage, 0));
                    }
                    Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => return Err(startup_failure(refused)),
                }
            }
        })();
        let provider_id = match prepared {
            Ok(id) => id,
            Err(e) => {
                let _ = controller.shutdown_runtime();
                return Err(e);
            }
        };
        let state = Arc::new(Mutex::new(WireState {
            active: None,
            retired: false,
            started: false,
            message: String::new(),
            last_message: None,
            usage: false,
            stop_deadline: None,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (c, s, t, e, sid, pid) = (
            controller.clone(),
            state.clone(),
            stop.clone(),
            sink.clone(),
            id.to_string(),
            provider_id.clone(),
        );
        let pump = thread::Builder::new()
            .name("pedelec-claude-events".into())
            .spawn(move || {
                let mut tracer = ToolTracer::new(TraceProvider::Claude);
                let active = |s: &Mutex<WireState>| s.lock().ok().and_then(|s| s.active.clone());
                while !t.load(Ordering::Acquire) {
                    if stop_expired(&s) {
                        c.retire_after_failed_stop();
                        fault(&s, &e, &sid, "PROVIDER_STOP_UNCONFIRMED");
                        break;
                    }
                    if drain_metadata(&c, &sid, &e, Some((&mut tracer, active(&s)))).is_err() {
                        fault(&s, &e, &sid, "PROVIDER_DISCONNECTED");
                        break;
                    }
                    match c.recv_event_timeout(Duration::from_millis(100)) {
                        Ok(event) => {
                            // Tool frames captured before this event are observed before it is forwarded.
                            if drain_metadata(&c, &sid, &e, Some((&mut tracer, active(&s)))).is_err() {
                                fault(&s, &e, &sid, "PROVIDER_DISCONNECTED");
                                break;
                            }
                            if !forward(event, &s, &stage, &e, &sid, &pid) {
                                break;
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(_) => {
                            fault(&s, &e, &sid, "PROVIDER_DISCONNECTED");
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
        let receipt = json!({"provider":"claude","runtimeStarted":true,"rehydrated":persisted.is_some(),"providerSessionId":provider_id,
            "providerVersion":provider.version,
            "capabilities":{"rehydrate-session":"supported","open-session":"supported","send":"supported","close-session":"supported",
                "cancel":"supported","resume-provider":"supported","tool-reply":"unsupported",
                "cli-tool-transport":"supported"},
            "hostTools":true});
        Ok((
            Self {
                id: id.into(),
                provider_id,
                controller,
                state,
                stop,
                pump: Some(pump),
            },
            receipt,
        ))
    }
    fn check(&self, id: &str) -> Result<(), IpcFailure> {
        if id != self.id {
            return Err(failure("CONFLICT"));
        }
        if self.state.lock().map_err(|_| failure("INTERNAL"))?.retired
            || !self.controller.is_healthy()
        {
            return Err(failure("PROVIDER_SESSION_RETIRED"));
        }
        Ok(())
    }
    pub(crate) fn send(&mut self, id: &str, p: SendPayload) -> Result<Value, IpcFailure> {
        self.check(id)?;
        if !crate::protocol::valid_id(&p.turn_id)
            || p.text.trim().is_empty()
            || p.text.len() > 512 * 1024
        {
            return Err(failure("INVALID_INPUT"));
        }
        let mut state = self.state.lock().map_err(|_| failure("INTERNAL"))?;
        if state.active.is_some() {
            return Err(failure("CONFLICT"));
        }
        state.active = Some(p.turn_id.clone());
        state.started = false;
        state.message.clear();
        state.last_message = None;
        state.usage = false;
        state.stop_deadline = None;
        if self.controller.start_turn(&p.turn_id, &p.text).is_err() {
            state.retired = true;
            let _ = self.controller.shutdown_runtime();
            return Err(failure("PROVIDER_OUTCOME_UNKNOWN"));
        }
        Ok(json!({"accepted":true,"turnId":p.turn_id,"providerSessionId":self.provider_id}))
    }
    pub(crate) fn resume(&self, id: &str, persisted: &str) -> Result<Value, IpcFailure> {
        self.check(id)?;
        if persisted != self.provider_id {
            return Err(failure("PROVIDER_SESSION_MISMATCH"));
        }
        Ok(json!({"resumed":true,"providerSessionId":self.provider_id}))
    }
    /// Soft stop on the live stdin. The terminal comes from Claude's own result frame;
    /// a stop nobody confirms ends the generation through the pump's deadline.
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
        loop {
            match self.controller.request_interrupt(&turn) {
                Ok(ClaudeInterruptRequest::Requested) => break,
                Ok(ClaudeInterruptRequest::NotReady) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(ClaudeInterruptRequest::NotReady) | Err(_) => {
                    self.state.lock().map_err(|_| failure("INTERNAL"))?.retired = true;
                    self.stop.store(true, Ordering::Release);
                    self.controller.retire_after_failed_stop();
                    return Ok(
                        json!({"cancelled":true,"turnId":turn,"outcome":"unknown","sessionRetired":true}),
                    );
                }
            }
        }
        self.state
            .lock()
            .map_err(|_| failure("INTERNAL"))?
            .stop_deadline = Some(Instant::now() + STOP_ACK_DEADLINE);
        Ok(json!({"cancelled":true,"turnId":turn}))
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
    fn stop_runtime(&mut self) -> usize {
        if let Ok(mut s) = self.state.lock() {
            s.retired = true;
        }
        self.stop.store(true, Ordering::Release);
        let mut errors = usize::from(self.controller.shutdown_runtime().is_err());
        if let Some(p) = self.pump.take() {
            errors += usize::from(p.join().is_err());
        }
        errors
    }
}
impl Drop for ClaudeSession {
    fn drop(&mut self) {
        self.stop_runtime();
    }
}
fn stop_expired(state: &Mutex<WireState>) -> bool {
    state
        .lock()
        .is_ok_and(|s| s.active.is_some() && s.stop_deadline.is_some_and(|at| Instant::now() >= at))
}
fn fault(state: &Mutex<WireState>, sink: &EventSink, id: &str, code: &str) {
    if let Ok(mut s) = state.lock() {
        if s.retired {
            return;
        }
        s.retired = true;
    }
    let _ = sink.emit(id, "provider-error", json!({"code":code}));
}
fn forward(
    event: ClaudeRuntimeEvent,
    state: &Mutex<WireState>,
    stage: &ArtifactStage,
    sink: &EventSink,
    id: &str,
    provider_id: &str,
) -> bool {
    use ClaudeRuntimeEvent::*;
    if matches!(event, ProtocolError { .. } | Disconnected { .. }) {
        let code = if matches!(event, ProtocolError { .. }) {
            "PROVIDER_PROTOCOL_ERROR"
        } else {
            "PROVIDER_DISCONNECTED"
        };
        fault(state, sink, id, code);
        return false;
    }
    let mut s = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if s.retired {
        return false;
    }
    let turn = s.active.clone();
    let emit = match event {
        SessionReady { session_id } if session_id != provider_id => {
            drop(s);
            fault(state, sink, id, "PROVIDER_SESSION_MISMATCH");
            return false;
        }
        TurnStarted { local_turn_id } if turn.as_ref() == Some(&local_turn_id) && !s.started => {
            s.started = true;
            Some((
                "turn",
                json!({"type":"started","turnId":local_turn_id,"providerTurnId":local_turn_id}),
            ))
        }
        AssistantDelta {
            local_turn_id,
            text,
        } if turn.as_ref() == Some(&local_turn_id) => {
            let (text, truncated) = bounded_text(text);
            Some((
                "turn",
                json!({"type":"assistant-delta","turnId":local_turn_id,"text":text,"truncated":truncated}),
            ))
        }
        AssistantMessage {
            local_turn_id,
            text,
        } if turn.as_ref() == Some(&local_turn_id) => {
            if s.last_message.as_ref() == Some(&text) {
                return true;
            }
            s.last_message = Some(text.clone());
            if s.message.len() <= 512 * 1024 {
                s.message.push_str(&text);
            }
            let (text, truncated) = bounded_text(s.message.clone());
            s.message = text.clone();
            Some((
                "turn",
                json!({"type":"assistant-message","turnId":local_turn_id,"text":text,"truncated":truncated}),
            ))
        }
        ProviderArtifact {
            local_turn_id,
            identity,
            tool_call_id,
            source,
            mime_type,
            payload,
        } if turn.as_ref() == Some(&local_turn_id) => {
            drop(s);
            let Ok(bytes) = payload else {
                stage.failed(&local_turn_id, "ARTIFACT_INVALID");
                return true;
            };
            stage.bytes(
                ArtifactMeta {
                    turn_id: &local_turn_id,
                    source: match source {
                        ClaudeArtifactSource::ToolResult => "tool_result",
                        ClaudeArtifactSource::ProviderArtifact => "provider_artifact",
                    },
                    provider_artifact_id: Some(&identity),
                    tool_call_id: tool_call_id.as_deref(),
                    filename: &format!("artifact.{}", extension_for_mime(&mime_type)),
                    mime_type: &mime_type,
                },
                &bytes,
            );
            return true;
        }
        UsageUpdated {
            local_turn_id: Some(t),
            usage,
        } if turn.as_ref() == Some(&t) && !s.usage => {
            s.usage = true;
            Some(("usage", numeric_fields(&usage, 0)))
        }
        TurnCompleted {
            local_turn_id: Some(t),
            success,
            session_id,
            ..
        } if turn.as_ref() == Some(&t) => {
            if session_id.as_deref() != Some(provider_id) {
                drop(s);
                fault(state, sink, id, "PROVIDER_SESSION_MISMATCH");
                return false;
            }
            s.active = None;
            s.stop_deadline = None;
            Some((
                "terminal",
                json!({"turnId":t,"status":if success{"completed"}else{"failed"}}),
            ))
        }
        TurnInterrupted {
            local_turn_id,
            session_id,
            ..
        } if turn.as_ref() == Some(&local_turn_id) => {
            if session_id.as_deref() != Some(provider_id) {
                drop(s);
                fault(state, sink, id, "PROVIDER_SESSION_MISMATCH");
                return false;
            }
            s.active = None;
            s.stop_deadline = None;
            Some((
                "terminal",
                json!({"turnId":local_turn_id,"status":"interrupted"}),
            ))
        }
        // Native tool frames stay inside Claude; they are never read as Host calls.
        _ => None,
    };
    emit.is_none_or(|(kind, data)| sink.emit(id, kind, data).is_ok())
}
fn drain_metadata(
    c: &ClaudeStreamController,
    id: &str,
    sink: &EventSink,
    mut trace: Option<(&mut ToolTracer, Option<String>)>,
) -> std::io::Result<()> {
    for _ in 0..256 {
        let Ok(r) = c.recv_protocol_traffic_timeout(Duration::ZERO) else {
            break;
        };
        // Tool trace sees every frame; the monitor filter below applies to provider-rpc only.
        if let Some((tracer, turn)) = trace.as_mut() {
            // Never returns an error: trace-only failures cannot stop this pump.
            tracer.trace(sink, id, &r, turn.as_deref());
        }
        if std::env::var("PEDELEC_MONITOR_DETAILS").as_deref() != Ok("1") && r.message["type"] == "stream_event" { continue; }
        if let Some(v) = protocol_traffic(&r, 0) {
            sink.emit(id, "provider-rpc", v)?;
        }
    }
    Ok(())
}
fn verify_cli(program: &Path) -> Result<(), IpcFailure> {
    let help = std::process::Command::new(program)
        .arg("--help")
        .output()
        .map_err(|_| failure("PROVIDER_UNAVAILABLE"))?;
    let h = String::from_utf8_lossy(&help.stdout);
    if !help.status.success()
        || ![
            "--dangerously-skip-permissions",
            "--effort",
            "--resume",
            "--input-format",
            "--output-format",
            "--include-partial-messages",
        ]
        .iter()
        .all(|f| h.contains(f))
    {
        return Err(failure("UNSUPPORTED_CAPABILITY"));
    }
    Ok(())
}
fn failure(code: &'static str) -> IpcFailure {
    IpcFailure::new(code, "Claude provider operation failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_access_refusals_are_told_apart_from_other_startup_errors() {
        assert!(refuses_full_access(
            "--dangerously-skip-permissions cannot be used with root/sudo"
        ));
        assert!(refuses_full_access(
            "Managed policy disabled bypassPermissions"
        ));
        assert!(!refuses_full_access("Invalid API key"));
    }
}
