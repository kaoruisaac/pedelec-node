//! Worker-private routing only. Each variant owns its controller/process and event pump.
//! Inputs are IPC v1 DTOs; receipts keep the existing IPC shape. The SDK owns
//! fail-closed turn outcomes. Host Tools reach the SDK Host only through `pedelec-cli` in the
//! provider's own shell: no registry, Host tool runner, MCP bridge or native tool ACK here.
mod acp;
mod antigravity;
mod claude;
mod codex;
pub(crate) mod common;
mod pedelec_agent;

use crate::{
    event_sink::EventSink,
    protocol::{HostToolDescriptor, OpenPayload, RehydratePayload, SendPayload},
    IpcFailure,
};
use serde_json::Value;

pub(crate) enum ProviderSession {
    Codex(codex::CodexSession),
    Acp(acp::AcpSession),
    Claude(claude::ClaudeSession),
    Ollama(pedelec_agent::PedelecAgentSession),
    Antigravity(antigravity::AntigravitySession),
}

impl ProviderSession {
    pub(crate) fn require_supported(provider: &str) -> Result<(), IpcFailure> {
        match provider {
            "codex" | "opencode" | "cursor" | "claude" | "ollama" | "antigravity" => Ok(()),
            _ => Err(unsupported()),
        }
    }

    // Preflight runs before launching a process, preserving worker validation order.
    pub(crate) fn validate_effort(provider: &str, effort: &str) -> Result<(), IpcFailure> {
        match provider {
            "codex" => codex::parse_effort(effort).map(|_| ()),
            "opencode" | "cursor" => acp::validate_effort(effort),
            "claude" => claude::parse_effort(effort).map(|_| ()),
            "ollama" => pedelec_agent::validate_effort(effort),
            "antigravity" => antigravity::parse_effort(effort).map(|_| ()),
            _ => Err(unsupported()),
        }
    }

    /// Every Provider shares one neutral descriptor check; none registers them natively.
    pub(crate) fn validate_tools(tools: &[HostToolDescriptor]) -> Result<(), IpcFailure> {
        common::validate_tools(tools)
    }

    pub(crate) fn open(
        id: &str,
        config: OpenPayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::validate_tools(&config.tools)?;
        let provider = config.provider.clone();
        let opened = match config.provider.as_str() {
            "codex" => {
                codex::CodexSession::open(id, config, events).map(|(s, r)| (Self::Codex(s), r))
            }
            "opencode" | "cursor" => {
                acp::AcpSession::open(id, config, events).map(|(s, r)| (Self::Acp(s), r))
            }
            "claude" => {
                claude::ClaudeSession::open(id, config, events).map(|(s, r)| (Self::Claude(s), r))
            }
            "ollama" => pedelec_agent::PedelecAgentSession::open(id, config, events)
                .map(|(s, r)| (Self::Ollama(s), r)),
            "antigravity" => antigravity::AntigravitySession::open(id, config, events)
                .map(|(s, r)| (Self::Antigravity(s), r)),
            _ => Err(unsupported()),
        };
        opened.map(|(session, receipt)| (session, with_tool_trace(receipt, &provider)))
    }

    pub(crate) fn rehydrate(
        id: &str,
        config: RehydratePayload,
        events: &EventSink,
    ) -> Result<(Self, Value), IpcFailure> {
        Self::validate_tools(&config.tools)?;
        let provider = config.provider.clone();
        let opened = match config.provider.as_str() {
            "codex" => {
                codex::CodexSession::rehydrate(id, config, events).map(|(s, r)| (Self::Codex(s), r))
            }
            "opencode" | "cursor" => {
                acp::AcpSession::rehydrate(id, config, events).map(|(s, r)| (Self::Acp(s), r))
            }
            "claude" => claude::ClaudeSession::rehydrate(id, config, events)
                .map(|(s, r)| (Self::Claude(s), r)),
            "ollama" => pedelec_agent::PedelecAgentSession::rehydrate(id, config, events)
                .map(|(s, r)| (Self::Ollama(s), r)),
            "antigravity" => antigravity::AntigravitySession::rehydrate(id, config, events)
                .map(|(s, r)| (Self::Antigravity(s), r)),
            _ => Err(unsupported()),
        };
        opened.map(|(session, receipt)| (session, with_tool_trace(receipt, &provider)))
    }

    pub(crate) fn send(&mut self, id: &str, turn: SendPayload) -> Result<Value, IpcFailure> {
        match self {
            Self::Codex(s) => s.send(id, turn),
            Self::Acp(s) => s.send(id, turn),
            Self::Claude(s) => s.send(id, turn),
            Self::Ollama(s) => s.send(id, turn),
            Self::Antigravity(s) => s.send(id, turn),
        }
    }

    pub(crate) fn cancel(&mut self, id: &str) -> Result<Value, IpcFailure> {
        match self {
            Self::Codex(s) => s.cancel(id),
            Self::Acp(s) => s.cancel(id),
            Self::Claude(s) => s.cancel(id),
            Self::Ollama(s) => s.cancel(id),
            Self::Antigravity(s) => s.cancel(id),
        }
    }

    pub(crate) fn resume(&self, id: &str, persisted_id: &str) -> Result<Value, IpcFailure> {
        match self {
            Self::Codex(s) => s.resume(id, persisted_id),
            Self::Acp(s) => s.resume(id, persisted_id),
            Self::Claude(s) => s.resume(id, persisted_id),
            Self::Ollama(s) => s.resume(id, persisted_id),
            Self::Antigravity(s) => s.resume(id, persisted_id),
        }
    }

    pub(crate) fn close(self, id: &str, events: &EventSink) -> Result<Value, IpcFailure> {
        match self {
            Self::Codex(s) => s.close(id, events),
            Self::Acp(s) => s.close(id, events),
            Self::Claude(s) => s.close(id, events),
            Self::Ollama(s) => s.close(id, events),
            Self::Antigravity(s) => s.close(id, events),
        }
    }

    pub(crate) fn artifact_hook(
        &self,
        id: &str,
        stage: &str,
        payload: Value,
    ) -> Result<Value, IpcFailure> {
        match self {
            Self::Antigravity(s) => s.artifact_hook(id, stage, payload),
            _ => Err(IpcFailure::new(
                "UNSUPPORTED_CAPABILITY",
                "provider has no artifact hook",
            )),
        }
    }

    /// EOF/shutdown cleanup consumes every session, counting process cleanup errors.
    pub(crate) fn cleanup(self, id: &str) -> usize {
        match self {
            Self::Codex(s) => s.cleanup(id),
            Self::Acp(s) => s.cleanup(id),
            Self::Claude(s) => s.cleanup(id),
            Self::Ollama(s) => s.cleanup(id),
            Self::Antigravity(s) => s.cleanup(id),
        }
    }
}

/// Declares the Level 1 tool-trace adapter beside the existing receipt fields; old fields keep their meaning.
fn with_tool_trace(mut receipt: Value, provider: &str) -> Value {
    if let Value::Object(fields) = &mut receipt {
        fields.insert("toolTrace".into(), crate::tool_trace::declared_coverage(provider));
    }
    receipt
}

fn unsupported() -> IpcFailure {
    IpcFailure::new(
        "UNSUPPORTED_PROVIDER",
        "requested provider is not supported by this worker",
    )
}
