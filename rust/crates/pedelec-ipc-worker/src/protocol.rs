use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead};

pub const VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub version: u64,
    pub request_id: String,
    pub session_id: Option<String>,
    pub op: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostToolDescriptor {
    pub name: String,
    pub description: String,
    pub args_schema: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenPayload {
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub server_workdir: String,
    #[serde(default)]
    pub host_instructions: String,
    #[serde(default)]
    pub tools: Vec<HostToolDescriptor>,
    /// Same-filesystem staging chosen by the trusted SDK; Provider output is copied here.
    #[serde(default)]
    pub artifact_staging_dir: Option<String>,
    /// Server-owned private directory for provider state kept outside the Task workdir.
    #[serde(default)]
    pub provider_state_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RehydratePayload {
    pub provider: String,
    pub provider_session_id: String,
    pub model: String,
    pub effort: RehydrateEffort,
    pub server_workdir: String,
    #[serde(default)]
    pub host_instructions: String,
    pub tools: Vec<HostToolDescriptor>,
    /// Same-filesystem staging chosen by the trusted SDK; Provider output is copied here.
    #[serde(default)]
    pub artifact_staging_dir: Option<String>,
    /// Server-owned private directory for provider state kept outside the Task workdir.
    #[serde(default)]
    pub provider_state_dir: Option<String>,
}

impl RehydratePayload {
    /// A rehydrate is an open with a known identity; both share one provider path.
    pub fn into_open(self) -> (OpenPayload, String) {
        let effort = match self.effort {
            RehydrateEffort::Default => "default",
            RehydrateEffort::Low => "low",
            RehydrateEffort::Medium => "medium",
            RehydrateEffort::High => "high",
            RehydrateEffort::Xhigh => "xhigh",
            RehydrateEffort::Max => "max",
        };
        (
            OpenPayload {
                provider: self.provider,
                model: self.model,
                effort: effort.into(),
                server_workdir: self.server_workdir,
                host_instructions: self.host_instructions,
                tools: self.tools,
                artifact_staging_dir: self.artifact_staging_dir,
                provider_state_dir: self.provider_state_dir,
            },
            self.provider_session_id,
        )
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RehydrateEffort {
    Default,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SendPayload {
    pub turn_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReasonPayload {
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResumePayload {
    pub provider_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactHookPayload {
    pub stage: String,
    pub hook_payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShutdownPayload {
    pub grace_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BoundedFrame {
    Frame(Vec<u8>),
    TooLarge,
    Eof,
    PartialEof,
}

/// Read one newline-delimited frame without ever buffering more than the
/// protocol limit. Oversized input is drained through its newline so the next
/// request can still be handled safely.
pub fn read_bounded_frame<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> io::Result<BoundedFrame> {
    let mut frame = Vec::with_capacity(max_bytes.min(8192));
    let mut too_large = false;
    loop {
        let (consumed, has_newline, chunk) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if too_large {
                    return Ok(BoundedFrame::TooLarge);
                }
                return Ok(if frame.is_empty() {
                    BoundedFrame::Eof
                } else {
                    BoundedFrame::PartialEof
                });
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(available.len());
            let chunk = if too_large || frame.len().saturating_add(count) > max_bytes {
                None
            } else {
                Some(available[..count].to_vec())
            };
            (
                count + usize::from(newline.is_some()),
                newline.is_some(),
                chunk,
            )
        };
        if let Some(chunk) = chunk {
            frame.extend_from_slice(&chunk);
        } else {
            too_large = true;
            frame.clear();
        }
        reader.consume(consumed);
        if has_newline {
            return Ok(if too_large {
                BoundedFrame::TooLarge
            } else {
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                BoundedFrame::Frame(frame)
            });
        }
    }
}

pub fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= MAX_ID_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_drains_oversized_frames_and_keeps_next_frame() {
        let mut input = Cursor::new(b"123456789\nnext\n".to_vec());
        assert_eq!(
            read_bounded_frame(&mut input, 4).unwrap(),
            BoundedFrame::TooLarge
        );
        assert_eq!(
            read_bounded_frame(&mut input, 4).unwrap(),
            BoundedFrame::Frame(b"next".to_vec())
        );
    }

    #[test]
    fn bounded_reader_requires_a_newline_terminator() {
        let mut input = Cursor::new(b"partial".to_vec());
        assert_eq!(
            read_bounded_frame(&mut input, 32).unwrap(),
            BoundedFrame::PartialEof
        );
    }

    #[test]
    fn request_rejects_unexpected_top_level_and_scope_fields() {
        let unexpected = serde_json::json!({
            "version": 1,
            "requestId": "r1",
            "sessionId": "s1",
            "scope": {"workspaceId":"w1","taskId":"t1","secret":"x"},
            "op": "send",
            "payload": {"turnId":"turn1","text":"hello"}
        });
        assert!(serde_json::from_value::<Request>(unexpected).is_err());
    }

    #[test]
    fn request_rejects_unknown_payload_fields() {
        let payload = serde_json::json!({
            "provider":"codex",
            "model":"gpt-test",
            "effort":"low",
            "serverWorkdir":"/workspace",
            "clientWorkdir":"/untrusted"
        });
        assert!(serde_json::from_value::<OpenPayload>(payload).is_err());
    }

    #[test]
    fn rehydrate_payload_requires_all_fields_and_rejects_unknown_fields() {
        let valid = serde_json::json!({
            "provider":"codex",
            "providerSessionId":"thread-123",
            "model":"gpt-test",
            "effort":"default",
            "serverWorkdir":"/workspace",
            "tools":[{
                "name":"echo",
                "description":"Synchronize the graph script.",
                "argsSchema":{"type":"object","properties":{},"required":[]}
            }]
        });
        assert!(serde_json::from_value::<RehydratePayload>(valid.clone()).is_ok());

        let mut incomplete = valid.clone();
        incomplete
            .as_object_mut()
            .unwrap()
            .remove("providerSessionId");
        assert!(serde_json::from_value::<RehydratePayload>(incomplete).is_err());

        let mut unknown = valid;
        unknown["clientWorkdir"] = serde_json::json!("/untrusted");
        assert!(serde_json::from_value::<RehydratePayload>(unknown).is_err());

        let invalid_effort = serde_json::json!({
            "provider":"codex",
            "providerSessionId":"thread-123",
            "model":"gpt-test",
            "effort":"unlimited",
            "serverWorkdir":"/workspace",
            "tools":[{
                "name":"echo",
                "description":"Synchronize the graph script.",
                "argsSchema":{"type":"object","properties":{},"required":[]}
            }]
        });
        assert!(serde_json::from_value::<RehydratePayload>(invalid_effort).is_err());
    }
}
