//! Ollama dispatcher migrated from Pedelec IPC, using the existing process controller.
//! Native fs/vision/web/restricted-bash tools run inside `pedelec-agent`; this module only
//! supplies its trusted launch environment and maps events. Host Tools reach the Agent's
//! restricted bash through `pedelec-cli` (MD19), never through a dedicated model tool.
use super::common::{
    canonical_workdir, cli_runtime_file, packaged_binary, provider_child_path, trusted_directory,
    valid_provider_session_id, validate_host_instructions, CLI_RUNTIME_FILE_ENV,
};
use crate::{
    event_sink::{bounded_text, numeric_fields, protocol_traffic, EventSink},
    protocol::{OpenPayload, RehydrateEffort, RehydratePayload, SendPayload},
    IpcFailure,
};
use pedelec_runtime::{
    PedelecAgentCancelRequest, PedelecAgentRuntimeEvent as Event, PedelecAgentRuntimeLaunchConfig,
    PedelecAgentServerController, PedelecAgentSessionConfig, PedelecAgentTurnStatus,
    ProviderRuntimeController,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const STOP_ACK_DEADLINE: Duration = Duration::from_secs(10);

struct State {
    active: Option<String>,
    unknown: bool,
    stop_deadline: Option<Instant>,
}
pub(crate) struct PedelecAgentSession {
    controller: Arc<PedelecAgentServerController>,
    provider_id: String,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    pump: Option<JoinHandle<()>>,
}
fn failure(code: &'static str, message: &'static str) -> IpcFailure {
    IpcFailure::new(code, message)
}
pub(super) fn validate_effort(effort: &str) -> Result<(), IpcFailure> {
    if effort == "default" {
        Ok(())
    } else {
        Err(failure(
            "INVALID_INPUT",
            "Ollama supports default effort only",
        ))
    }
}
impl PedelecAgentSession {
    pub(super) fn open(
        id: &str,
        config: OpenPayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::start(id, config, None, events)
    }
    pub(super) fn rehydrate(
        id: &str,
        config: RehydratePayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        if !valid_provider_session_id(&config.provider_session_id)
            || !matches!(config.effort, RehydrateEffort::Default)
        {
            return Err(failure(
                "INVALID_INPUT",
                "Invalid Ollama attach configuration",
            ));
        }
        let (open, persisted) = config.into_open();
        Self::start(id, open, Some(persisted), events)
    }
    fn start(
        id: &str,
        config: OpenPayload,
        persisted: Option<String>,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        validate_effort(&config.effort)?;
        validate_host_instructions(&config.host_instructions)?;
        if config.model.trim().is_empty() || config.model.len() > 512 || config.model.contains('\0')
        {
            return Err(failure("INVALID_INPUT", "Model is invalid"));
        }
        let workdir = canonical_workdir(&config.server_workdir)?;
        // The SDK supplies the Session's private store. Never fall back to a shared Home.
        let session_root =
            trusted_directory(config.provider_state_dir.as_deref())?.ok_or_else(|| {
                failure(
                    "INVALID_INPUT",
                    "Ollama requires a SDK-owned provider state directory",
                )
            })?;
        let program = packaged_binary("pedelec-agent").ok_or_else(|| {
            failure(
                "PROVIDER_UNAVAILABLE",
                "Packaged Pedelec Agent is unavailable",
            )
        })?;
        let mut launch = PedelecAgentRuntimeLaunchConfig::new(program, workdir.clone(), "ollama")
            .with_env("PEDELEC_PROVIDER", "ollama")
            .with_env("PATH", provider_child_path());
        launch.protocol_logging = false;
        // The restricted bash forwards this file to `pedelec-cli`.
        if let Some(file) = cli_runtime_file(!config.tools.is_empty())? {
            launch = launch.with_env(CLI_RUNTIME_FILE_ENV, file);
        }
        // Must outlast the SDK Tool budget, or the helper dies mid-Handler as an unknown effect.
        launch = launch.with_env("PEDELEC_AGENT_PEDELEC_CLI_TIMEOUT_MS", "125000");
        // The store lives outside the workdir.
        launch = launch.with_env("PEDELEC_AGENT_SESSION_ROOT", session_root);
        // The restricted bash resolves only this packaged helper, then PATH.
        if let Some(path) = packaged_binary("pedelec-cli") {
            launch = launch.with_env("PEDELEC_CLI_PATH", path);
        }
        // Only trusted Server process configuration supplies these; never Tool/browser args.
        for key in [
            "PEDELEC_OLLAMA_BASE_URL",
            "OLLAMA_API_KEY",
            "TAVILY_API_KEY",
        ] {
            if let Some(value) = std::env::var_os(key) {
                launch = launch.with_env(key, value);
            }
        }
        let web_search = std::env::var("TAVILY_API_KEY").is_ok_and(|key| !key.trim().is_empty());
        let controller = PedelecAgentServerController::spawn(launch).map_err(|_| {
            failure(
                "PROVIDER_UNAVAILABLE",
                "Pedelec Agent initialization failed",
            )
        })?;
        let instructions = format!(
            "{}\n[Pedelec Session]\nUse this thread id with restricted helpers: {id}\n",
            config.host_instructions
        );
        let opened = match controller.ensure_session(
            id,
            persisted.as_deref(),
            &PedelecAgentSessionConfig {
                model: config.model,
                workspace: workdir,
                host_instructions: Some(instructions),
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                let _ = controller.shutdown();
                // A tool-less model is a model limit, not missing Provider wiring.
                return Err(if error.to_string().contains("tool calling") {
                    failure(
                        "MODEL_TOOLS_UNSUPPORTED",
                        "Selected Ollama model does not support tool calling",
                    )
                } else {
                    failure(
                        "PROVIDER_MODEL_UNAVAILABLE",
                        "Ollama service, model or persisted session is unavailable",
                    )
                });
            }
        };
        let state = Arc::new(Mutex::new(State {
            active: None,
            unknown: false,
            stop_deadline: None,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let pump = match spawn_pump(
            controller.clone(),
            id.into(),
            state.clone(),
            stop.clone(),
            events.clone(),
        ) {
            Ok(pump) => pump,
            Err(_) => {
                let _ = controller.shutdown();
                return Err(failure("INTERNAL", "Event pump could not start"));
            }
        };
        let receipt = json!({"provider":"ollama","runtimeStarted":true,"providerSessionId":opened.agent_session_id,"rehydrated":persisted.is_some(),"hostTools":true,
            "modelCapabilities":{"tools":opened.model_capabilities.tools,"vision":opened.model_capabilities.vision},
            "nativeTools":{"files":true,"restrictedBash":true,"images":opened.model_capabilities.vision,"webSearch":web_search},
            "capabilities":{"open-session":"supported","rehydrate-session":"supported","send":"supported","cancel":"supported","close-session":"supported","resume-provider":"supported","tool-reply":"unsupported","cli-tool-transport":"supported"}});
        Ok((
            Self {
                controller,
                provider_id: opened.agent_session_id,
                state,
                stop,
                pump: Some(pump),
            },
            receipt,
        ))
    }
    pub(super) fn send(&mut self, id: &str, turn: SendPayload) -> Result<Value, IpcFailure> {
        {
            let mut state = self.state.lock().unwrap();
            if state.unknown || state.active.is_some() {
                return Err(failure(
                    "TURN_OUTCOME_UNKNOWN",
                    "Session is active or unknown; do not replay",
                ));
            }
            state.active = Some(turn.turn_id.clone());
            state.stop_deadline = None;
        }
        match self
            .controller
            .start_turn(id, &self.provider_id, &turn.turn_id, &turn.text)
        {
            Ok(_) => Ok(
                json!({"accepted":true,"turnId":turn.turn_id,"providerSessionId":self.provider_id}),
            ),
            Err(_) => {
                self.state.lock().unwrap().unknown = true;
                self.controller.retire();
                Err(failure(
                    "TURN_OUTCOME_UNKNOWN",
                    "Provider turn outcome is unknown; do not replay",
                ))
            }
        }
    }
    /// `turn/cancel` discards the turn whole and keeps the session; only its own
    /// `turn/completed` reports the result. An unconfirmed stop retires the process.
    pub(super) fn cancel(&mut self, id: &str) -> Result<Value, IpcFailure> {
        let turn = self
            .state
            .lock()
            .unwrap()
            .active
            .clone()
            .ok_or_else(|| failure("NO_ACTIVE_TURN", "No active turn"))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match self.controller.request_cancel(id, &turn) {
                Ok(PedelecAgentCancelRequest::Requested) => break,
                Ok(PedelecAgentCancelRequest::NotReady) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(PedelecAgentCancelRequest::NotReady) | Err(_) => {
                    self.state.lock().unwrap().unknown = true;
                    self.controller.retire();
                    return Err(failure(
                        "CANCEL_OUTCOME_UNKNOWN",
                        "Turn stopped; effects remain unknown; close session",
                    ));
                }
            }
        }
        self.state.lock().unwrap().stop_deadline = Some(Instant::now() + STOP_ACK_DEADLINE);
        Ok(json!({"cancelled":true,"turnId":turn}))
    }
    pub(super) fn resume(&self, _id: &str, persisted: &str) -> Result<Value, IpcFailure> {
        if persisted != self.provider_id
            || self.state.lock().unwrap().unknown
            || !self.controller.is_healthy()
        {
            return Err(failure(
                "PROVIDER_SESSION_MISMATCH",
                "Cannot resume this provider session",
            ));
        }
        Ok(json!({"resumed":true,"providerSessionId":self.provider_id}))
    }
    fn finish(&mut self, id: &str) -> usize {
        self.stop.store(true, Ordering::Release);
        let turn = self.state.lock().unwrap().active.clone();
        let close = self
            .controller
            .close_session(id, Some(&self.provider_id), turn.as_deref())
            .is_err();
        let shutdown = self.controller.shutdown().is_err();
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
        usize::from(close) + usize::from(shutdown)
    }
    pub(super) fn cleanup(mut self, id: &str) -> usize {
        self.finish(id)
    }
    pub(super) fn close(mut self, id: &str, events: &EventSink) -> Result<Value, IpcFailure> {
        if self.finish(id) > 0 {
            return Err(failure("CLEANUP_FAILED", "Provider process cleanup failed"));
        }
        events
            .emit(id, "terminal", json!({"status":"closed"}))
            .map_err(|_| failure("INTERNAL", "Event write failed"))?;
        Ok(json!({"closed":true}))
    }
}
impl Drop for PedelecAgentSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.controller.shutdown();
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}
/// Release Server stages these beside the Worker. No PATH or untrusted override.
fn spawn_pump(
    controller: Arc<PedelecAgentServerController>,
    id: String,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    events: EventSink,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new().name("ollama-events".into()).spawn(move || {
        while !stop.load(Ordering::Acquire) {
            for _ in 0..256 { let Ok(record)=controller.recv_protocol_traffic_timeout(Duration::ZERO) else {break}; if let Some(meta)=protocol_traffic(&record,0) { if events.emit(&id,"provider-rpc",meta).is_err() {controller.retire();return;} } }
            {
                let mut current=state.lock().unwrap();
                if current.active.is_some() && current.stop_deadline.is_some_and(|at|Instant::now()>=at) {
                    current.unknown=true;
                    drop(current);
                    controller.retire();
                    let _=events.emit(&id,"provider-error",json!({"code":"PROVIDER_STOP_UNCONFIRMED","message":"Provider outcome unknown; do not replay"}));
                    break;
                }
            }
            let event=match controller.recv_event_timeout(Duration::from_millis(25)) { Ok(v)=>v, Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>continue, Err(_)=>break };
            if stop.load(Ordering::Acquire) {break;}
            let mut current=state.lock().unwrap();
            if current.unknown {continue;}
            let output=match event {
                Event::TurnStarted {turn_id,..} if current.active.as_deref()==Some(&turn_id)=>Some(("turn",json!({"turnId":turn_id,"type":"started"}))),
                Event::AssistantDelta {turn_id,text,..} if current.active.as_deref()==Some(&turn_id)=> {let (text,truncated)=bounded_text(text);Some(("turn",json!({"turnId":turn_id,"type":"assistant-delta","text":text,"truncated":truncated})))},
                Event::AssistantMessage {turn_id,text,..} if current.active.as_deref()==Some(&turn_id)=> {let (text,truncated)=bounded_text(text);Some(("turn",json!({"turnId":turn_id,"type":"assistant-message","text":text,"truncated":truncated})))},
                Event::UsageUpdated {turn_id,usage,..} if current.active.as_deref()==Some(&turn_id)=>Some(("usage",numeric_fields(&usage,0))),
                Event::TurnCompleted {turn_id,status,..} if current.active.as_deref()==Some(&turn_id)=> {
                    current.stop_deadline=None;
                    match status {
                        PedelecAgentTurnStatus::Completed=>{current.active=None;Some(("terminal",json!({"turnId":turn_id,"status":"completed"})))}
                        PedelecAgentTurnStatus::Interrupted=>{current.active=None;Some(("terminal",json!({"turnId":turn_id,"status":"interrupted"})))}
                        _=>{current.unknown=true;Some(("provider-error",json!({"turnId":turn_id,"code":"TURN_OUTCOME_UNKNOWN","message":"Provider turn failed or tool outcome unknown"})))}
                    }
                },
                Event::ProtocolError {..}|Event::Disconnected {..}=>{current.unknown=true;Some(("provider-error",json!({"code":"PROVIDER_DISCONNECTED","message":"Provider outcome unknown; do not replay"})))},
                _=>None,
            };
            drop(current);
            if let Some((kind,data))=output { if events.emit(&id,kind,data).is_err() {controller.retire();break;} }
        }
    })
}
