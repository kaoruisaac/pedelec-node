mod artifacts;
mod event_sink;
mod protocol;
mod providers;
mod storage;
mod tool_trace;
#[cfg(test)]
mod tool_trace_tests;
use event_sink::{write_frame, EventSink};
use pedelec_shared::storage::StorageLease;
use protocol::{
    read_bounded_frame, ArtifactHookPayload, BoundedFrame, OpenPayload, ReasonPayload,
    RehydratePayload, Request, ResumePayload, SendPayload, ShutdownPayload, MAX_FRAME_BYTES,
    VERSION,
};
use providers::{
    common::{
        valid_provider_session_id, validate_host_instructions, validate_reason,
    },
    ProviderSession,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufReader, BufWriter};
use std::process;
use std::sync::{Arc, Mutex};
const MAX_REQUEST_IDS: usize = 65_536;
const MAX_TEXT_BYTES: usize = 512 * 1024;
#[derive(Debug, Clone)]
struct IpcFailure {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl IpcFailure {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            retryable: false,
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

struct Session {
    provider: ProviderSession,
}
fn write_success(
    output: &Arc<Mutex<BufWriter<io::Stdout>>>,
    request_id: &str,
    data: Value,
) -> io::Result<()> {
    write_frame(
        output,
        &json!({"version": VERSION, "requestId": request_id, "ok": true, "data": data}),
    )
}

fn write_error(
    output: &Arc<Mutex<BufWriter<io::Stdout>>>,
    request_id: &str,
    error: IpcFailure,
) -> io::Result<()> {
    write_frame(
        output,
        &json!({
            "version": VERSION,
            "requestId": request_id,
            "ok": false,
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            }
        }),
    )
}

fn request_id_hint(value: &Value) -> Option<&str> {
    value.get("requestId").and_then(Value::as_str)
}

fn reply_for_bad_frame(output: &Arc<Mutex<BufWriter<io::Stdout>>>, value: &Value) {
    if let Some(request_id) = request_id_hint(value).filter(|id| protocol::valid_id(id)) {
        let version = value.get("version").and_then(Value::as_u64);
        let failure = if version != Some(VERSION) {
            IpcFailure::new("UNSUPPORTED_VERSION", "IPC protocol version is unsupported")
        } else {
            IpcFailure::new("INVALID_INPUT", "IPC request fields are invalid")
        };
        let _ = write_error(output, request_id, failure);
    } else {
        eprintln!("discarded IPC frame without a valid requestId");
    }
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!(
            "{}",
            json!({"name": env!("CARGO_PKG_NAME"), "version": env!("CARGO_PKG_VERSION"), "protocolVersion": VERSION})
        );
        return;
    }
    if args == ["--provider-scan"] {
        println!("{}", providers::common::provider_scan());
        return;
    }
    if let [flag, root, id] = args.as_slice() {
        if flag == "--storage-keeper" {
            let id = (id != "-").then_some(id.as_str());
            if storage::run(root.into(), id).is_err() {
                eprintln!("pedelec storage: ownership or filesystem check refused");
                process::exit(1);
            }
            return;
        }
    }
    if !args.is_empty() {
        process::exit(1);
    }
    if run().is_err() {
        eprintln!("Pedelec IPC worker stopped after an I/O failure");
        process::exit(1);
    }
}

fn run() -> io::Result<()> {
    let lease = StorageLease::from_env()?;
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let events = EventSink {
        output: Arc::clone(&output),
        sequences: Arc::new(Mutex::new(HashMap::new())),
    };
    let stdin = io::stdin();
    let mut input = BufReader::new(stdin.lock());
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut request_ids = HashSet::new();

    loop {
        match read_bounded_frame(&mut input, MAX_FRAME_BYTES)? {
            BoundedFrame::Eof => {
                close_all(&mut sessions);
                return Ok(());
            }
            BoundedFrame::PartialEof => {
                eprintln!("discarded unterminated IPC frame at EOF");
                close_all(&mut sessions);
                return Ok(());
            }
            BoundedFrame::TooLarge => {
                eprintln!("discarded oversized IPC frame");
                continue;
            }
            BoundedFrame::Frame(bytes) => {
                if bytes.is_empty() {
                    eprintln!("discarded empty IPC frame");
                    continue;
                }
                let value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(_) => {
                        eprintln!("discarded malformed JSON IPC frame");
                        continue;
                    }
                };
                let request_id = request_id_hint(&value)
                    .filter(|id| protocol::valid_id(id))
                    .map(str::to_string);
                let Some(request_id) = request_id else {
                    eprintln!("discarded IPC frame without a valid requestId");
                    continue;
                };
                if value.get("version").and_then(Value::as_u64) != Some(VERSION) {
                    write_error(
                        &output,
                        &request_id,
                        IpcFailure::new(
                            "UNSUPPORTED_VERSION",
                            "IPC protocol version is unsupported",
                        ),
                    )?;
                    continue;
                }
                let request: Request = match serde_json::from_value(value.clone()) {
                    Ok(request) => request,
                    Err(_) => {
                        reply_for_bad_frame(&output, &value);
                        continue;
                    }
                };
                if request_ids.contains(&request.request_id) {
                    write_error(
                        &output,
                        &request.request_id,
                        IpcFailure::new("DUPLICATE_REQUEST_ID", "requestId was already used"),
                    )?;
                    continue;
                }
                if request_ids.len() >= MAX_REQUEST_IDS {
                    write_error(
                        &output,
                        &request.request_id,
                        IpcFailure::new("REQUEST_LIMIT", "worker request limit reached"),
                    )?;
                    close_all(&mut sessions);
                    return Ok(());
                }
                request_ids.insert(request.request_id.clone());

                let request_id = request.request_id.clone();
                match dispatch(request, &mut sessions, &events, &output, lease.as_ref()) {
                    Ok(Dispatch::Continue(data)) => {
                        if let Err(error) = write_success(&output, &request_id, data) {
                            close_all(&mut sessions);
                            return Err(error);
                        }
                    }
                    Ok(Dispatch::Stop(data)) => {
                        write_success(&output, &request_id, data)?;
                        close_all(&mut sessions);
                        return Ok(());
                    }
                    Err(error) => write_error(&output, &request_id, error)?,
                }
            }
        }
    }
}

enum Dispatch {
    Continue(Value),
    Stop(Value),
}

fn dispatch(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    events: &EventSink,
    output: &Arc<Mutex<BufWriter<io::Stdout>>>,
    lease: Option<&StorageLease>,
) -> Result<Dispatch, IpcFailure> {
    if request.version != VERSION {
        return Err(IpcFailure::new(
            "UNSUPPORTED_VERSION",
            "IPC protocol version is unsupported",
        ));
    }
    match request.op.as_str() {
        "open-session" => open_session(request, sessions, events, lease).map(Dispatch::Continue),
        "rehydrate-session" => {
            rehydrate_session(request, sessions, events, lease).map(Dispatch::Continue)
        }
        "send" => send_turn(request, sessions).map(Dispatch::Continue),
        "cancel" => cancel_turn(request, sessions).map(Dispatch::Continue),
        "close-session" => close_session(request, sessions, events).map(Dispatch::Continue),
        "resume-provider" => resume_provider(request, sessions).map(Dispatch::Continue),
        // CLI Host Tools answer on the SDK endpoint; this frame never reaches a Provider.
        "tool-reply" => Err(IpcFailure::new(
            "UNSUPPORTED_IN_CLI_MODE",
            "Host tools use session-scoped pedelec-cli IPC",
        )),
        "provider-artifact-hook" => artifact_hook(request, sessions).map(Dispatch::Continue),
        "shutdown" => shutdown(request, sessions, output).map(Dispatch::Stop),
        _ => Err(IpcFailure::new("UNKNOWN_OP", "IPC operation is unknown")),
    }
}

fn require_session_id(request: &Request) -> Result<&str, IpcFailure> {
    request
        .session_id
        .as_deref()
        .filter(|value| protocol::valid_id(value))
        .ok_or_else(|| IpcFailure::new("INVALID_INPUT", "sessionId is required"))
}

fn decode_payload<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, IpcFailure> {
    serde_json::from_value(value)
        .map_err(|_| IpcFailure::new("INVALID_INPUT", "operation payload is invalid"))
}

fn require_open_session<'a>(
    session_id: &str,
    sessions: &'a mut HashMap<String, Session>,
) -> Result<&'a mut Session, IpcFailure> {
    sessions
        .get_mut(session_id)
        .ok_or_else(|| IpcFailure::new("NOT_FOUND", "session is not open"))
}

fn open_session(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    events: &EventSink,
    lease: Option<&StorageLease>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: OpenPayload = decode_payload(request.payload)?;
    ProviderSession::require_supported(&payload.provider)?;
    storage::validate_session_paths(
        lease,
        &session_id,
        &payload.provider,
        payload.provider_state_dir.as_deref(),
        payload.artifact_staging_dir.as_deref(),
    )
    .map_err(|_| IpcFailure::new("INVALID_INPUT", "SDK storage paths are invalid"))?;
    if sessions.contains_key(&session_id) {
        return Err(IpcFailure::new("CONFLICT", "sessionId is already open"));
    }
    if payload.model.trim().is_empty() {
        return Err(IpcFailure::new("INVALID_INPUT", "model is required"));
    }
    ProviderSession::validate_effort(&payload.provider, &payload.effort)?;
    ProviderSession::validate_tools(&payload.tools)?;
    validate_host_instructions(&payload.host_instructions)?;
    let (provider, receipt) = ProviderSession::open(&session_id, payload, events)?;
    sessions.insert(session_id, Session { provider });
    Ok(receipt)
}
fn rehydrate_session(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    events: &EventSink,
    lease: Option<&StorageLease>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: RehydratePayload = decode_payload(request.payload)?;

    ProviderSession::require_supported(&payload.provider)?;
    storage::validate_session_paths(
        lease,
        &session_id,
        &payload.provider,
        payload.provider_state_dir.as_deref(),
        payload.artifact_staging_dir.as_deref(),
    )
    .map_err(|_| IpcFailure::new("INVALID_INPUT", "SDK storage paths are invalid"))?;
    if !valid_provider_session_id(&payload.provider_session_id) {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "providerSessionId is invalid",
        ));
    }
    if payload.model.trim().is_empty() || payload.model.len() > 512 {
        return Err(IpcFailure::new("INVALID_INPUT", "model is invalid"));
    }
    ProviderSession::validate_tools(&payload.tools)?;
    validate_host_instructions(&payload.host_instructions)?;
    if sessions.contains_key(&session_id) {
        return Err(IpcFailure::new("CONFLICT", "sessionId is already open"));
    }

    let (provider, receipt) = ProviderSession::rehydrate(&session_id, payload, events)?;
    sessions.insert(session_id, Session { provider });
    Ok(receipt)
}
fn send_turn(
    request: Request,
    sessions: &mut HashMap<String, Session>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: SendPayload = decode_payload(request.payload)?;
    if !protocol::valid_id(&payload.turn_id) || payload.text.trim().is_empty() {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "turnId and text are required",
        ));
    }
    if payload.text.len() > MAX_TEXT_BYTES {
        return Err(IpcFailure::new(
            "FRAME_TOO_LARGE",
            "turn text exceeds the limit",
        ));
    }
    let session = require_open_session(&session_id, sessions)?;
    session.provider.send(&session_id, payload)
}
fn cancel_turn(
    request: Request,
    sessions: &mut HashMap<String, Session>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: ReasonPayload = decode_payload(request.payload)?;
    validate_reason(&payload.reason)?;
    let session = require_open_session(&session_id, sessions)?;
    session.provider.cancel(&session_id)
}
fn resume_provider(
    request: Request,
    sessions: &mut HashMap<String, Session>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: ResumePayload = decode_payload(request.payload)?;
    if !protocol::valid_id(&payload.provider_session_id) {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "providerSessionId is invalid",
        ));
    }
    let session = require_open_session(&session_id, sessions)?;
    session
        .provider
        .resume(&session_id, &payload.provider_session_id)
}
fn artifact_hook(
    request: Request,
    sessions: &mut HashMap<String, Session>,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: ArtifactHookPayload = decode_payload(request.payload)?;
    let session = require_open_session(&session_id, sessions)?;
    session
        .provider
        .artifact_hook(&session_id, &payload.stage, payload.hook_payload)
}
fn close_session(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    events: &EventSink,
) -> Result<Value, IpcFailure> {
    let session_id = require_session_id(&request)?.to_string();
    let payload: ReasonPayload = decode_payload(request.payload)?;
    validate_reason(&payload.reason)?;
    if !sessions.contains_key(&session_id) {
        return Err(IpcFailure::new("NOT_FOUND", "session is not open"));
    }
    let session = sessions
        .remove(&session_id)
        .expect("session presence checked");
    session.provider.close(&session_id, events)
}
fn shutdown(
    request: Request,
    sessions: &mut HashMap<String, Session>,
    _output: &Arc<Mutex<BufWriter<io::Stdout>>>,
) -> Result<Value, IpcFailure> {
    let payload: ShutdownPayload = decode_payload(request.payload)?;
    if payload.grace_ms > 60_000 {
        return Err(IpcFailure::new(
            "INVALID_INPUT",
            "graceMs exceeds the limit",
        ));
    }
    let count = sessions.len();
    let errors = close_all(sessions);
    if errors > 0 {
        return Err(IpcFailure::new(
            "CLEANUP_FAILED",
            "one or more provider processes did not shut down cleanly",
        ));
    }
    Ok(json!({"shutdown": true, "closedSessions": count}))
}

fn close_all(sessions: &mut HashMap<String, Session>) -> usize {
    sessions
        .drain()
        .map(|(id, session)| session.provider.cleanup(&id))
        .sum()
}
