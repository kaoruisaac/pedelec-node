//! IPC event sequencing, bounded writes and metadata-only telemetry. No session reducer.
use crate::protocol::{MAX_FRAME_BYTES, VERSION};
use pedelec_runtime::ProtocolTrafficRecord;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufWriter, Write};
use std::sync::{Arc, Mutex};
const MAX_TEXT_BYTES: usize = 512 * 1024;
#[derive(Clone)]
pub(crate) struct EventSink {
    pub(crate) output: Arc<Mutex<BufWriter<io::Stdout>>>,
    pub(crate) sequences: Arc<Mutex<HashMap<String, u64>>>,
}

impl EventSink {
    pub(crate) fn emit(&self, session_id: &str, kind: &str, data: Value) -> io::Result<()> {
        // Keep assignment and flush ordered across concurrent provider/bridge pumps.
        let mut sequences = self
            .sequences
            .lock()
            .map_err(|_| io::Error::other("event sequence lock unavailable"))?;
        let sequence = sequences.entry(session_id.to_string()).or_insert(0);
        *sequence = sequence.saturating_add(1);
        write_frame(
            &self.output,
            &json!({
                "version": VERSION,
                "sessionId": session_id,
                "sequence": sequence,
                "kind": kind,
                "data": data,
            }),
        )
    }
}

#[cfg(test)]
pub(crate) fn next_sequence(
    sequences: &Mutex<HashMap<String, u64>>,
    session_id: &str,
) -> io::Result<u64> {
    let mut sequences = sequences
        .lock()
        .map_err(|_| io::Error::other("event sequence lock unavailable"))?;
    let next = sequences.entry(session_id.to_string()).or_insert(0);
    *next = next.saturating_add(1);
    Ok(*next)
}

pub(crate) fn write_frame(
    output: &Arc<Mutex<BufWriter<io::Stdout>>>,
    frame: &Value,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "outgoing IPC frame exceeded the limit",
        ));
    }
    let mut output = output
        .lock()
        .map_err(|_| io::Error::other("stdout lock unavailable"))?;
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()
}

pub(crate) fn protocol_metadata(
    record: &ProtocolTrafficRecord,
    skipped_deltas: u64,
) -> Option<Value> {
    let method = record.message.get("method").and_then(Value::as_str);
    if method.is_some_and(|name| name.to_ascii_lowercase().contains("delta")) {
        return None;
    }
    let bytes = serde_json::to_vec(&record.message).map_or(0, |encoded| encoded.len());
    Some(json!({
        "at": record.ts,
        "direction": safe_label(&record.direction),
        "kind": safe_label(&record.kind),
        "method": method.map(|name| match name {
            "initialize" | "initialized" | "authenticate" | "model/list"
            | "thread/start" | "thread/resume" | "thread/unsubscribe" | "thread/tokenUsage/updated"
            | "turn/start" | "turn/started" | "turn/completed" | "turn/interrupt"
            | "item/started" | "item/completed" | "item/tool/call"
            | "session/new" | "session/load" | "session/prompt" | "session/cancel"
            | "session/update" | "session/request_permission" | "session/set_config_option"
            | "session/set_mode" | "session/config" | "session/attach" | "session/detach"
            | "session/open" | "session/close" | "session/tools"
            | "turn/tool_call" | "turn/tool_reply" | "turn/usage" | "turn/assistant_message"
            | "antigravity/user" | "antigravity/init" | "antigravity/result" | "antigravity/other" => name,
            _ => "other",
        }),
        "id": record.message.get("id").filter(|id| id.is_u64() || id.is_i64()),
        "error": record.message.get("error").map(|error| error.get("code").filter(|code| code.is_i64()).cloned().unwrap_or(json!(true))),
        "unmatched": record.unmatched,
        "bytes": bytes,
        "skippedDeltas": skipped_deltas,
    }))
}

/// Bounded diagnostic copy of a provider frame. The monitor never owns a provider controller.
pub(crate) fn bounded_rpc_value(value: &Value, depth: usize) -> Value {
    if depth >= 6 { return json!("[max-depth]"); }
    match value {
        Value::String(value) => {
            let mut text: String = value.chars().take(4096).collect();
            if text.len() < value.len() { text.push_str("…[truncated]"); }
            json!(text)
        }
        Value::Array(items) => Value::Array(items.iter().take(32)
            .map(|item| bounded_rpc_value(item, depth + 1)).collect()),
        Value::Object(fields) => {
            let mut kept = serde_json::Map::new();
            for (key, item) in fields.iter().take(32) {
                let key_lower = key.to_ascii_lowercase();
                let sensitive = ["password", "passphrase", "secret", "token", "authorization",
                    "cookie", "credential", "api_key", "apikey", "private_key"]
                    .iter().any(|part| key_lower.contains(part));
                kept.insert(key.clone(), if sensitive { json!("[redacted]") }
                    else { bounded_rpc_value(item, depth + 1) });
            }
            if fields.len() > 32 { kept.insert("…".into(), json!("[remaining fields omitted]")); }
            Value::Object(kept)
        }
        _ => value.clone(),
    }
}

/// Provider RPC is a traffic view, distinct from the legacy metadata-only observer.
pub(crate) fn protocol_traffic(record: &ProtocolTrafficRecord, skipped_deltas: u64) -> Option<Value> {
    if std::env::var("PEDELEC_MONITOR_DETAILS").as_deref() != Ok("1") {
        return protocol_metadata(record, skipped_deltas);
    }
    protocol_traffic_detailed(record, skipped_deltas)
}

fn protocol_traffic_detailed(record: &ProtocolTrafficRecord, skipped_deltas: u64) -> Option<Value> {
    let mut surrogate = record.clone();
    // The legacy metadata-only path drops deltas; the traffic view must show them.
    if surrogate.message.get("method").and_then(Value::as_str)
        .is_some_and(|method| method.to_ascii_lowercase().contains("delta")) {
        surrogate.message = json!({"method": "other"});
    }
    let mut traffic = protocol_metadata(&surrogate, skipped_deltas)?;
    traffic["bytes"] = json!(serde_json::to_vec(&record.message).map_or(0, |bytes| bytes.len()));
    let payload = bounded_rpc_value(&record.message, 0);
    let serialized = serde_json::to_string(&payload).ok()?;
    traffic["payload"] = if serialized.len() <= 32 * 1024 { payload } else {
        json!({"preview": serialized.chars().take(16 * 1024).collect::<String>(), "truncated": true})
    };
    Some(traffic)
}

fn safe_label(value: &str) -> String {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/_.-".contains(ch))
    {
        value.to_string()
    } else {
        "other".to_string()
    }
}

/// Usage is telemetry, so only its counters are kept; no provider string can pass through this event.
pub(crate) fn numeric_fields(value: &Value, depth: usize) -> Value {
    let Value::Object(fields) = value else {
        return Value::Null;
    };
    let mut kept = serde_json::Map::new();
    for (key, field) in fields.iter().take(32) {
        if field.is_number() {
            kept.insert(usage_label(key).to_owned(), field.clone());
        } else if field.is_object() && depth < 3 {
            kept.insert(
                usage_label(key).to_owned(),
                numeric_fields(field, depth + 1),
            );
        }
    }
    Value::Object(kept)
}

fn usage_label(key: &str) -> &str {
    match key {
        "total"
        | "last"
        | "usage"
        | "tokens"
        | "input_tokens"
        | "output_tokens"
        | "total_tokens"
        | "inputTokens"
        | "outputTokens"
        | "totalTokens"
        | "cachedInputTokens"
        | "reasoningOutputTokens"
        | "cached_input_tokens"
        | "reasoning_output_tokens"
        | "cache_read_input_tokens"
        | "cache_creation_input_tokens"
        | "prompt_tokens"
        | "completion_tokens"
        | "prompt_eval_count"
        | "eval_count"
        | "input_tokens_details"
        | "output_tokens_details"
        | "cached_tokens"
        | "reasoning_tokens" => key,
        _ => "other",
    }
}

pub(crate) fn bounded_text(text: String) -> (String, bool) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text, false);
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

#[cfg(test)]
mod monitor_metadata_tests {
    use super::*;

    fn record(message: Value) -> ProtocolTrafficRecord {
        ProtocolTrafficRecord {
            ts: "2026-11-04T00:00:00.000Z".into(),
            direction: "outbound".into(),
            kind: "request".into(),
            thread_id: Some("thread".into()),
            message,
            unmatched: false,
        }
    }

    #[test]
    fn protocol_traffic_preserves_bounded_payloads_including_deltas() {
        let traffic = protocol_traffic_detailed(&record(json!({
            "method": "turn/start",
            "params": {"text": "Hello", "api_key": "secret-value"}
        })), 0).expect("traffic");
        assert_eq!(traffic["payload"]["params"]["text"], "Hello");
        assert_eq!(traffic["payload"]["params"]["api_key"], "[redacted]");
        assert!(!traffic.to_string().contains("secret-value"));
        let delta = protocol_traffic_detailed(&record(json!({
            "method": "item/agentMessage/delta", "params": {"text": "Hi"}
        })), 0).expect("delta");
        assert_eq!(delta["payload"]["params"]["text"], "Hi");
    }

    #[test]
    fn protocol_metadata_never_carries_message_bodies() {
        let metadata = protocol_metadata(
            &record(json!({"id": 7, "method": "turn/start", "params": {"input": "secret prompt"}})),
            2,
        )
        .expect("metadata");
        assert_eq!(metadata["method"], "turn/start");
        assert_eq!(metadata["id"], 7);
        assert_eq!(metadata["skippedDeltas"], 2);
        assert!(metadata["bytes"].as_u64().unwrap() > 0);
        assert!(!metadata.to_string().contains("secret prompt"));
    }

    #[test]
    fn protocol_metadata_keeps_only_a_numeric_error_code() {
        let metadata = protocol_metadata(
            &record(
                json!({"id": "opaque-secret", "error": {"code": -32000, "message": "token=abc"}}),
            ),
            0,
        )
        .expect("metadata");
        assert_eq!(metadata["error"], -32000);
        assert_eq!(metadata["id"], Value::Null);
        assert!(!metadata.to_string().contains("token=abc"));
        let text_code =
            protocol_metadata(&record(json!({"error": {"code": "private"}})), 0).unwrap();
        assert_eq!(text_code["error"], true);
    }

    #[test]
    fn protocol_metadata_skips_per_token_deltas_and_unsafe_labels() {
        assert!(
            protocol_metadata(&record(json!({"method": "item/agentMessage/delta"})), 0).is_none()
        );
        let metadata =
            protocol_metadata(&record(json!({"method": "bad method /Users/alice"})), 0).unwrap();
        assert_eq!(metadata["method"], "other");
    }

    #[test]
    fn telemetry_labels_cannot_carry_provider_secrets() {
        let metadata =
            protocol_metadata(&record(json!({"method":"PRIVATE_PROMPT_SENTINEL"})), 0).unwrap();
        assert_eq!(metadata["method"], "other");
        let usage = numeric_fields(&json!({"PRIVATE_PROMPT_SENTINEL": 4}), 0);
        assert_eq!(usage, json!({"other":4}));
    }

    #[test]
    fn usage_keeps_only_counters() {
        let usage = numeric_fields(
            &json!({"total": {"totalTokens": 12, "note": "secret"}, "model": "private", "last": 3}),
            0,
        );
        assert_eq!(usage, json!({"total": {"totalTokens": 12}, "last": 3}));
        assert_eq!(numeric_fields(&json!("secret"), 0), Value::Null);
    }
}

#[cfg(test)]
mod sequence_tests {
    use super::*;
    #[test]
    fn event_writer_assigns_monotonic_per_session_sequences() {
        let sequences = Mutex::new(HashMap::new());
        assert_eq!(next_sequence(&sequences, "s1").unwrap(), 1);
        assert_eq!(next_sequence(&sequences, "s2").unwrap(), 1);
        assert_eq!(next_sequence(&sequences, "s1").unwrap(), 2);
    }
}
