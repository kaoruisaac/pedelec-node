//! Level 1 Agent Tool Trace: provider-specific adapters that read the provider protocol traffic the
//! runtime already captures (always on, independent of `PEDELEC_MONITOR_DETAILS`) and turn each
//! provider-exposed Tool frame into one bounded `agent-tool` IPC observation.
//!
//! Contract (01A, event-first):
//! - Observation only: nothing here answers, approves, retries or delays a provider frame.
//! - One provider frame → its own observation(s), in arrival order. No lifecycle state machine, no
//!   dedupe, no synthetic terminal. A frame this module cannot classify is never guessed into a tool.
//! - Values are **not redacted** (trusted Server consumer; it owns ACL/retention). Only size bounds
//!   apply, and every cut is marked `truncated`.
//! - The only state is small, hard-capped protocol ID caches (FIFO eviction) for fields a protocol
//!   does not repeat (Claude `tool_use_id → name`, ACP `toolCallId → title/kind`, pending approvals).
//!   An evicted entry yields `unavailable`, never a guess.
//! - Trace failures (parse panic, oversized or failed emit, failed gap emit) never propagate to the
//!   provider pump: [`ToolTracer::trace`] returns nothing. A broken shared IPC writer is still detected
//!   by the pump's own next business emit, which keeps the existing fault contract.
use crate::event_sink::EventSink;
use pedelec_runtime::ProtocolTrafficRecord;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Per-string cap before the SDK applies its own, smaller field limits (it reports the truncation).
const MAX_STRING_BYTES: usize = 32 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_DEPTH: usize = 6;
/// Whole observation cap; far below the 1 MiB IPC frame limit.
pub(crate) const MAX_OBSERVATION_BYTES: usize = 192 * 1024;
/// Hard cap per protocol ID cache; oldest entries are evicted first.
pub(crate) const MAX_TRACKED_IDS: usize = 1024;
/// Max dropped-observation count reported in one `TRACE_EMIT_FAILED` gap (saturating).
const MAX_PENDING_DROPS: u64 = u64::MAX;

/// Adapter coverage the Worker declares in its open receipt. Source-level only; real-provider QA
/// is recorded separately and never inferred from this value.
pub(crate) fn declared_coverage(provider: &str) -> Value {
    let (coverage, adapter) = match provider {
        "codex" => ("supported", "codex-app-server-items"),
        "claude" => ("supported", "claude-stream-json-tool-use"),
        "opencode" => ("supported", "acp-session-update-opencode"),
        "cursor" => ("supported", "acp-session-update-cursor"),
        // step_update exposes no verified tool-invocation identity; see TraceProvider::Antigravity.
        "antigravity" => ("unsupported", "antigravity-step-update-unclassified"),
        // pedelec-agent native tool trace is Backlog PN-B001; nothing is parsed for it here.
        _ => ("unsupported", "none"),
    };
    json!({"coverage": coverage, "adapter": adapter, "version": 1})
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TraceProvider {
    Codex,
    Claude,
    OpenCode,
    Cursor,
    Antigravity,
}

impl TraceProvider {
    pub(crate) fn acp(provider: &str) -> Self {
        if provider == "cursor" {
            Self::Cursor
        } else {
            Self::OpenCode
        }
    }
}

/// Pending ACP permission request: native call id plus option id → option kind.
struct PermissionRequest {
    tool_call_id: String,
    options: HashMap<String, String>,
}

/// Hard-capped, FIFO-evicting protocol ID cache. `len() <= cap` always holds.
pub(crate) struct BoundedCache<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
    cap: usize,
    evicted: u64,
}

impl<V> BoundedCache<V> {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap: cap.max(1),
            evicted: 0,
        }
    }
    pub(crate) fn insert(&mut self, key: String, value: V) {
        if self.map.insert(key.clone(), value).is_some() {
            return; // Same key refreshed in place; its FIFO slot is unchanged.
        }
        self.order.push_back(key);
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                if self.map.remove(&old).is_some() {
                    self.evicted += 1;
                }
            }
        }
    }
    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }
    pub(crate) fn remove(&mut self, key: &str) -> Option<V> {
        let value = self.map.remove(key)?;
        if let Some(at) = self.order.iter().position(|k| k == key) {
            self.order.remove(at);
        }
        Some(value)
    }
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }
    #[cfg(test)]
    pub(crate) fn evicted(&self) -> u64 {
        self.evicted
    }
}

/// Where observations go. `EventSink` in production; failing sinks in fault-injection tests.
pub(crate) trait TraceSink {
    fn emit_trace(&self, session_id: &str, data: Value) -> std::io::Result<()>;
}

impl TraceSink for EventSink {
    fn emit_trace(&self, session_id: &str, data: Value) -> std::io::Result<()> {
        self.emit(session_id, "agent-tool", data)
    }
}

/// Debug-build-only fault injection (`PEDELEC_TOOL_TRACE_FAULT=parse,emit,gap`), used by the
/// real-Worker SDK tests. Release builds never read the variable.
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct TraceFaults {
    pub(crate) parse: bool,
    pub(crate) emit: bool,
    pub(crate) gap: bool,
}

impl TraceFaults {
    fn from_env() -> Self {
        #[cfg(debug_assertions)]
        {
            let raw = std::env::var("PEDELEC_TOOL_TRACE_FAULT").unwrap_or_default();
            let has = |name: &str| raw.split(',').any(|part| part.trim() == name);
            Self {
                parse: has("parse"),
                emit: has("emit"),
                gap: has("gap"),
            }
        }
        #[cfg(not(debug_assertions))]
        {
            Self::default()
        }
    }
}

pub(crate) struct ToolTracer {
    provider: TraceProvider,
    /// Claude `tool_use_id` → (tool name, parent tool use id); tool_result frames omit the name.
    claude_calls: BoundedCache<(String, Option<String>)>,
    /// Codex approval request id → item id.
    codex_approvals: BoundedCache<String>,
    acp_permissions: BoundedCache<PermissionRequest>,
    /// ACP tool call id → first known (title, kind); updates often omit both.
    acp_calls: BoundedCache<(String, String)>,
    /// Antigravity step types that were not classified as tools, per turn.
    unclassified_steps: BTreeMap<String, u64>,
    /// Observations (and gaps) that could not be emitted since the last delivered gap.
    pending_drops: u64,
    pending_turn: Option<String>,
    pub(crate) faults: TraceFaults,
}

impl ToolTracer {
    pub(crate) fn new(provider: TraceProvider) -> Self {
        Self {
            provider,
            claude_calls: BoundedCache::new(MAX_TRACKED_IDS),
            codex_approvals: BoundedCache::new(MAX_TRACKED_IDS),
            acp_permissions: BoundedCache::new(MAX_TRACKED_IDS),
            acp_calls: BoundedCache::new(MAX_TRACKED_IDS),
            unclassified_steps: BTreeMap::new(),
            pending_drops: 0,
            pending_turn: None,
            faults: TraceFaults::from_env(),
        }
    }

    /// Sizes of every protocol ID cache (tests assert the hard cap).
    #[cfg(test)]
    pub(crate) fn cache_sizes(&self) -> [usize; 4] {
        [
            self.claude_calls.len(),
            self.codex_approvals.len(),
            self.acp_permissions.len(),
            self.acp_calls.len(),
        ]
    }

    #[cfg(test)]
    pub(crate) fn cache_evictions(&self) -> u64 {
        self.claude_calls.evicted()
            + self.codex_approvals.evicted()
            + self.acp_permissions.evicted()
            + self.acp_calls.evicted()
    }

    /// Observes one traffic record and emits its observations. Never fails and never panics out:
    /// a parse panic becomes a `TRACE_PARSE_FAILED` gap, an emit failure is counted into a later
    /// `TRACE_EMIT_FAILED` gap. The caller's pump continues regardless.
    pub(crate) fn trace<S: TraceSink>(
        &mut self,
        sink: &S,
        session_id: &str,
        record: &ProtocolTrafficRecord,
        turn: Option<&str>,
    ) {
        let inject = self.faults.parse;
        let observed = catch_unwind(AssertUnwindSafe(|| {
            if inject {
                panic!("injected tool-trace parse fault");
            }
            self.observe(record, turn)
        }));
        let observations = observed.unwrap_or_else(|_| {
            vec![json!({
                "phase": "gap", "turnId": turn, "errorCode": "TRACE_PARSE_FAILED", "coverage": "partial",
                "providerEvent": "worker/tool_trace",
            })]
        });
        self.send_all(sink, session_id, observations, turn);
    }

    /// Turn-end evidence (Antigravity unclassified steps). Same isolation as [`Self::trace`].
    pub(crate) fn finish_turn<S: TraceSink>(
        &mut self,
        sink: &S,
        session_id: &str,
        turn: Option<&str>,
    ) {
        let observations =
            catch_unwind(AssertUnwindSafe(|| self.turn_finished(turn))).unwrap_or_default();
        self.send_all(sink, session_id, observations, turn);
    }

    fn send_all<S: TraceSink>(
        &mut self,
        sink: &S,
        session_id: &str,
        observations: Vec<Value>,
        turn: Option<&str>,
    ) {
        if observations.is_empty() {
            return;
        }
        // Earlier losses are reported first, once, before newer observations.
        self.flush_pending_gap(sink, session_id);
        for observation in observations {
            let is_gap = observation.get("phase").and_then(Value::as_str) == Some("gap");
            match self.send(sink, session_id, observation.clone(), is_gap) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    // Oversized after all bounds: identity-only gap, attempted once (no recursion).
                    let gap = json!({
                        "phase": "gap", "turnId": observation.get("turnId"), "errorCode": "OBSERVATION_TOO_LARGE",
                        "coverage": "partial", "nativeToolCallId": observation.get("nativeToolCallId"),
                    });
                    if self.send(sink, session_id, gap, true).is_err() {
                        self.count_drop(turn);
                    }
                }
                Err(_) => self.count_drop(turn),
            }
        }
    }

    fn flush_pending_gap<S: TraceSink>(&mut self, sink: &S, session_id: &str) {
        if self.pending_drops == 0 {
            return;
        }
        let gap = json!({
            "phase": "gap", "turnId": self.pending_turn, "errorCode": "TRACE_EMIT_FAILED", "coverage": "partial",
            "detail": {"droppedObservations": self.pending_drops},
        });
        // One attempt per batch; on failure the count stays for the next batch.
        if self.send(sink, session_id, gap, true).is_ok() {
            self.pending_drops = 0;
            self.pending_turn = None;
        }
    }

    fn count_drop(&mut self, turn: Option<&str>) {
        if self.pending_drops < MAX_PENDING_DROPS {
            self.pending_drops += 1;
        }
        if self.pending_turn.is_none() {
            self.pending_turn = turn.map(str::to_string);
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_drops(&self) -> u64 {
        self.pending_drops
    }

    fn send<S: TraceSink>(
        &self,
        sink: &S,
        session_id: &str,
        value: Value,
        is_gap: bool,
    ) -> std::io::Result<()> {
        if (is_gap && self.faults.gap) || (!is_gap && self.faults.emit) {
            return Err(std::io::Error::other("injected tool-trace emit fault"));
        }
        sink.emit_trace(session_id, value)
    }

    /// Observations for one traffic record. Never fails: a malformed frame yields nothing.
    pub(crate) fn observe(
        &mut self,
        record: &ProtocolTrafficRecord,
        turn: Option<&str>,
    ) -> Vec<Value> {
        let at = record.ts.as_str();
        let mut out = match self.provider {
            TraceProvider::Codex => self.codex(record, turn, at),
            TraceProvider::Claude => self.claude(record, turn, at),
            TraceProvider::OpenCode | TraceProvider::Cursor => self.acp(record, turn, at),
            TraceProvider::Antigravity => self.antigravity(record),
        };
        for observation in &mut out {
            fit(observation);
        }
        out
    }

    /// Evidence that closes a turn for providers without verified tool events. No tool record is
    /// invented: the gap only names step types the provider streamed and this adapter did not map.
    pub(crate) fn turn_finished(&mut self, turn: Option<&str>) -> Vec<Value> {
        if self.provider != TraceProvider::Antigravity || self.unclassified_steps.is_empty() {
            self.unclassified_steps.clear();
            return Vec::new();
        }
        let steps = std::mem::take(&mut self.unclassified_steps);
        vec![json!({
            "phase": "gap", "turnId": turn, "errorCode": "PROVIDER_STEPS_UNCLASSIFIED",
            "coverage": "unsupported",
            "detail": {"unclassifiedStepTypes": steps},
        })]
    }

    // ----- Codex App Server (item/started, item/completed, approvals) -----
    fn codex(
        &mut self,
        record: &ProtocolTrafficRecord,
        turn: Option<&str>,
        at: &str,
    ) -> Vec<Value> {
        let message = &record.message;
        let method = message.get("method").and_then(Value::as_str);
        if record.direction == "client_to_provider" && method.is_none() {
            // A response to a server approval request.
            let Some(id) = message.get("id").map(id_key) else {
                return Vec::new();
            };
            let Some(item_id) = self.codex_approvals.remove(&id) else {
                return Vec::new();
            };
            let decision = message
                .pointer("/result/decision")
                .and_then(Value::as_str)
                .unwrap_or("");
            if matches!(decision, "decline" | "denied" | "cancel" | "abort") {
                return vec![obs(
                    turn,
                    at,
                    "updated",
                    Some(&item_id),
                    None,
                    "unknown",
                    "unknown",
                    Some("denied"),
                    None,
                    None,
                    None,
                    Some("PROVIDER_APPROVAL_DECLINED"),
                    &[],
                    "codex/approval",
                )];
            }
            return Vec::new();
        }
        let Some(method) = method else {
            return Vec::new();
        };
        let params = message.get("params").unwrap_or(&Value::Null);
        if method.ends_with("/requestApproval") {
            if let (Some(id), Some(item)) = (
                message.get("id"),
                params.get("itemId").and_then(Value::as_str),
            ) {
                self.codex_approvals.insert(id_key(id), item.to_string());
            }
            return Vec::new();
        }
        let phase = match method {
            "item/started" => "started",
            "item/completed" => "finished",
            _ => return Vec::new(),
        };
        let Some(item) = params.get("item").and_then(Value::as_object) else {
            return Vec::new();
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let status = codex_status(item.get("status").and_then(Value::as_str), phase);
        let label = if phase == "started" {
            "codex/item/started"
        } else {
            "codex/item/completed"
        };
        match kind {
            "userMessage" | "agentMessage" | "reasoning" | "plan" | "contextCompaction"
            | "enteredReviewMode" | "exitedReviewMode" | "" => Vec::new(),
            "commandExecution" => {
                let exit = item.get("exitCode").and_then(Value::as_i64);
                let mut unavailable = vec!["stdout", "stderr"];
                if phase == "finished" && exit.is_none() {
                    unavailable.push("exitCode");
                }
                let output = item
                    .get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .map(|text| json!({"output": text, "combinedStreams": true}));
                if phase == "finished" && output.is_none() {
                    unavailable.push("output");
                }
                let mut input = Map::new();
                copy(item, &mut input, "command", "command");
                copy(item, &mut input, "cwd", "cwd");
                vec![obs(
                    turn,
                    at,
                    phase,
                    id,
                    None,
                    "commandExecution",
                    "shell",
                    status,
                    exit,
                    Some(Value::Object(input)),
                    output,
                    None,
                    &unavailable,
                    label,
                )]
            }
            "fileChange" => {
                let changes = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .map(|changes| {
                        Value::Array(changes.iter().take(MAX_ENTRIES).map(|change| json!({
                        "path": change.get("path"),
                        "kind": change.pointer("/kind/type").or_else(|| change.get("kind")),
                        "diff": change.get("diff"),
                    })).collect())
                    });
                vec![obs(
                    turn,
                    at,
                    phase,
                    id,
                    None,
                    "fileChange",
                    "file",
                    status,
                    None,
                    Some(json!({"changes": changes})),
                    None,
                    None,
                    &["exitCode", "output"],
                    label,
                )]
            }
            "mcpToolCall" => {
                let tool = item
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("mcpToolCall");
                let input = json!({"server": item.get("server"), "tool": tool, "arguments": item.get("arguments")});
                let output = (phase == "finished").then(|| json!({"result": item.get("result"), "error": item.get("error").and_then(|e| e.get("message"))}));
                let error = item
                    .get("error")
                    .filter(|e| !e.is_null())
                    .map(|_| "MCP_TOOL_ERROR");
                vec![obs(
                    turn,
                    at,
                    phase,
                    id,
                    None,
                    tool,
                    "mcp",
                    status,
                    None,
                    Some(input),
                    output,
                    error,
                    &["exitCode"],
                    label,
                )]
            }
            "webSearch" => vec![obs(
                turn,
                at,
                phase,
                id,
                None,
                "webSearch",
                "search",
                status,
                None,
                Some(json!({"query": item.get("query")})),
                None,
                None,
                &["exitCode", "output"],
                label,
            )],
            "imageView" => vec![obs(
                turn,
                at,
                phase,
                id,
                None,
                "imageView",
                "file",
                status,
                None,
                Some(json!({"path": item.get("path")})),
                None,
                None,
                &["exitCode", "output"],
                label,
            )],
            "imageGeneration" => vec![obs(
                turn,
                at,
                phase,
                id,
                None,
                "imageGeneration",
                "other",
                status,
                None,
                None,
                None,
                None,
                &["exitCode", "input", "output"],
                label,
            )],
            "dynamicToolCall" | "collabAgentToolCall" => {
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or(kind);
                vec![obs(
                    turn,
                    at,
                    phase,
                    id,
                    None,
                    tool,
                    "other",
                    status,
                    None,
                    item.get("arguments").map(|a| json!({"arguments": a})),
                    None,
                    None,
                    &["exitCode"],
                    label,
                )]
            }
            other => vec![obs(
                turn,
                at,
                phase,
                id,
                None,
                &safe_label(other),
                "unknown",
                status,
                None,
                None,
                None,
                Some("PROVIDER_ITEM_UNCLASSIFIED"),
                &["input", "output", "exitCode"],
                label,
            )],
        }
    }

    // ----- Claude Code stream-json (assistant tool_use, user tool_result) -----
    fn claude(
        &mut self,
        record: &ProtocolTrafficRecord,
        turn: Option<&str>,
        at: &str,
    ) -> Vec<Value> {
        if record.direction != "provider_to_client" {
            return Vec::new();
        }
        let message = &record.message;
        let frame = message.get("type").and_then(Value::as_str).unwrap_or("");
        let parent = message
            .get("parent_tool_use_id")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        let Some(content) = message
            .pointer("/message/content")
            .and_then(Value::as_array)
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            match (frame, block.get("type").and_then(Value::as_str)) {
                ("assistant", Some("tool_use")) => {
                    let Some(id) = block
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                    else {
                        continue;
                    };
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    self.claude_calls.insert(
                        id.to_string(),
                        (name.to_string(), parent.map(str::to_string)),
                    );
                    let input = block.get("input").cloned();
                    out.push(obs(
                        turn,
                        at,
                        "started",
                        Some(id),
                        parent,
                        name,
                        claude_kind(name),
                        Some("running"),
                        None,
                        input,
                        None,
                        None,
                        &[],
                        "claude/assistant/tool_use",
                    ));
                }
                ("user", Some("tool_result")) => {
                    let Some(id) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                    else {
                        continue;
                    };
                    let (name, known_parent) = self
                        .claude_calls
                        .get(id)
                        .cloned()
                        .unwrap_or(("unknown".into(), None));
                    let detail = message
                        .get("tool_use_result")
                        .or_else(|| message.get("toolUseResult"));
                    let interrupted = detail
                        .and_then(|d| d.get("interrupted"))
                        .and_then(Value::as_bool)
                        == Some(true);
                    let is_error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    let status = if interrupted {
                        "cancelled"
                    } else if is_error {
                        "failed"
                    } else {
                        "completed"
                    };
                    let mut unavailable = vec!["exitCode"];
                    let output = match detail {
                        Some(Value::Object(fields))
                            if fields.contains_key("stdout") || fields.contains_key("stderr") =>
                        {
                            let mut kept = Map::new();
                            copy(fields, &mut kept, "stdout", "stdout");
                            copy(fields, &mut kept, "stderr", "stderr");
                            copy(fields, &mut kept, "interrupted", "interrupted");
                            copy(fields, &mut kept, "timedOutAfterMs", "timedOutAfterMs");
                            Value::Object(kept)
                        }
                        _ => {
                            if claude_kind(&name) == "shell" {
                                unavailable.extend(["stdout", "stderr"]);
                            }
                            json!({"content": block.get("content")})
                        }
                    };
                    let error = if is_error {
                        Some("PROVIDER_TOOL_ERROR")
                    } else {
                        None
                    };
                    let parent = parent.map(str::to_string).or(known_parent);
                    if name == "unknown" {
                        unavailable.push("toolName");
                    }
                    out.push(obs(
                        turn,
                        at,
                        "finished",
                        Some(id),
                        parent.as_deref(),
                        &name,
                        claude_kind(&name),
                        Some(status),
                        None,
                        None,
                        Some(output),
                        error,
                        &unavailable,
                        "claude/user/tool_result",
                    ));
                }
                _ => {}
            }
        }
        out
    }

    // ----- ACP session/update (OpenCode and Cursor parsed separately) -----
    fn acp(&mut self, record: &ProtocolTrafficRecord, turn: Option<&str>, at: &str) -> Vec<Value> {
        let message = &record.message;
        let method = message.get("method").and_then(Value::as_str);
        if record.direction == "provider_to_client" && method == Some("session/request_permission")
        {
            let params = message.get("params").unwrap_or(&Value::Null);
            if let (Some(id), Some(call)) = (
                message.get("id"),
                params
                    .pointer("/toolCall/toolCallId")
                    .and_then(Value::as_str),
            ) {
                let options = params
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|o| {
                                Some((
                                    o.get("optionId")?.as_str()?.to_string(),
                                    o.get("kind")?.as_str()?.to_string(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.acp_permissions.insert(
                    id_key(id),
                    PermissionRequest {
                        tool_call_id: call.to_string(),
                        options,
                    },
                );
            }
            return Vec::new();
        }
        if record.direction == "client_to_provider" && method.is_none() {
            let Some(id) = message.get("id").map(id_key) else {
                return Vec::new();
            };
            let Some(request) = self.acp_permissions.remove(&id) else {
                return Vec::new();
            };
            let outcome = message
                .pointer("/result/outcome/outcome")
                .and_then(Value::as_str);
            let option = message
                .pointer("/result/outcome/optionId")
                .and_then(Value::as_str);
            let rejected = outcome == Some("cancelled")
                || option
                    .and_then(|o| request.options.get(o))
                    .is_some_and(|kind| kind.starts_with("reject"));
            if !rejected {
                return Vec::new();
            }
            let (name, kind) = self
                .acp_calls
                .get(&request.tool_call_id)
                .cloned()
                .unwrap_or(("unknown".into(), "unknown".into()));
            return vec![obs(
                turn,
                at,
                "updated",
                Some(&request.tool_call_id),
                None,
                &name,
                &kind,
                Some("denied"),
                None,
                None,
                None,
                Some("PROVIDER_PERMISSION_REJECTED"),
                &[],
                "acp/request_permission",
            )];
        }
        if method != Some("session/update") {
            return Vec::new();
        }
        let Some(update) = message.pointer("/params/update").and_then(Value::as_object) else {
            return Vec::new();
        };
        let session_update = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if session_update != "tool_call" && session_update != "tool_call_update" {
            return Vec::new();
        }
        let id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let raw_status = update.get("status").and_then(Value::as_str);
        let status = match raw_status {
            Some("pending" | "in_progress") => "running",
            Some("completed") => "completed",
            Some("failed") => "failed",
            Some(_) => "unknown",
            None if session_update == "tool_call" => "running",
            None => "running",
        };
        let terminal = matches!(raw_status, Some("completed" | "failed"));
        let phase = if terminal {
            "finished"
        } else if session_update == "tool_call" {
            "started"
        } else {
            "updated"
        };
        let known = id.and_then(|id| self.acp_calls.get(id)).cloned();
        let acp_kind = update
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| known.as_ref().map(|k| k.1.clone()))
            .unwrap_or_else(|| "other".into());
        let (name, name_reported) = match self.provider {
            TraceProvider::Cursor => cursor_tool_name(update, known.as_ref()),
            _ => opencode_tool_name(update, known.as_ref()),
        };
        if let Some(id) = id {
            self.acp_calls
                .insert(id.to_string(), (name.clone(), acp_kind.clone()));
        }
        let tool_kind = acp_tool_kind(&acp_kind);
        let mut unavailable: Vec<&str> = Vec::new();
        if !name_reported {
            unavailable.push("toolName");
        }
        let input = update
            .get("rawInput")
            .cloned()
            .map(|raw| {
                let mut input = json!({"rawInput": raw});
                if let Some(title) = update.get("title") {
                    input["title"] = title.clone();
                }
                if let Some(locations) = update.get("locations") {
                    input["locations"] = locations.clone();
                }
                input
            })
            .or_else(|| update.get("title").map(|title| json!({"title": title})));
        if input.is_none() && phase == "started" {
            unavailable.push("input");
        }
        let raw_output = update.get("rawOutput");
        let exit = raw_output
            .and_then(|raw| {
                raw.get("exitCode")
                    .or_else(|| raw.get("exit_code"))
                    .or_else(|| raw.pointer("/metadata/exit"))
            })
            .and_then(Value::as_i64);
        if terminal && tool_kind == "shell" && exit.is_none() {
            unavailable.push("exitCode");
        }
        let output = match (raw_output, update.get("content")) {
            (Some(raw), _) => Some(json!({"rawOutput": raw})),
            (None, Some(content)) if terminal => Some(json!({"content": content})),
            _ => None,
        };
        if terminal && output.is_none() {
            unavailable.push("output");
        }
        let error = (raw_status == Some("failed")).then_some("PROVIDER_TOOL_FAILED");
        let label = if session_update == "tool_call" {
            "acp/session/update/tool_call"
        } else {
            "acp/session/update/tool_call_update"
        };
        vec![obs(
            turn,
            at,
            phase,
            id,
            None,
            &name,
            tool_kind,
            Some(status),
            exit,
            input,
            output,
            error,
            &unavailable,
            label,
        )]
    }

    // ----- Antigravity: capability probe only -----
    fn antigravity(&mut self, record: &ProtocolTrafficRecord) -> Vec<Value> {
        if record.direction != "provider_to_client" {
            return Vec::new();
        }
        let message = &record.message;
        if message.get("event").and_then(Value::as_str) != Some("step_update") {
            return Vec::new();
        }
        let step = message
            .get("step_type")
            .and_then(Value::as_str)
            .unwrap_or("missing");
        if step != "agent_response" && self.unclassified_steps.len() < MAX_ENTRIES {
            *self.unclassified_steps.entry(safe_label(step)).or_insert(0) += 1;
        } else if step != "agent_response" {
            *self.unclassified_steps.entry("other".into()).or_insert(0) += 1;
        }
        Vec::new()
    }
}

#[allow(clippy::too_many_arguments)]
fn obs(
    turn: Option<&str>,
    at: &str,
    phase: &str,
    native_id: Option<&str>,
    parent: Option<&str>,
    tool_name: &str,
    tool_kind: &str,
    status: Option<&str>,
    exit_code: Option<i64>,
    input: Option<Value>,
    output: Option<Value>,
    error_code: Option<&str>,
    unavailable: &[&str],
    provider_event: &str,
) -> Value {
    let mut truncated = false;
    let input = input.map(|value| bound(&value, 0, &mut truncated));
    let output = output.map(|value| bound(&value, 0, &mut truncated));
    let mut unavailable: Vec<&str> = unavailable.to_vec();
    if native_id.is_none() {
        unavailable.push("nativeToolCallId");
    }
    if turn.is_none() {
        unavailable.push("turnId");
    }
    let mut value = json!({
        "phase": phase,
        "at": at,
        "turnId": turn,
        "nativeToolCallId": native_id.map(|id| bound_str(id, 256, &mut truncated)),
        "parentNativeToolCallId": parent.map(|id| bound_str(id, 256, &mut truncated)),
        "toolName": bound_str(tool_name, 256, &mut truncated),
        "toolKind": tool_kind,
        "status": status,
        "input": input,
        "output": output,
        "errorCode": error_code,
        "unavailable": unavailable,
        "truncated": truncated,
        "providerEvent": provider_event,
    });
    if let Some(code) = exit_code {
        value["exitCode"] = json!(code);
    }
    value
}

/// Last resort when an observation is still too large: drop detail, keep identity and outcome.
fn fit(observation: &mut Value) {
    let size = serde_json::to_vec(observation).map_or(usize::MAX, |bytes| bytes.len());
    if size <= MAX_OBSERVATION_BYTES {
        return;
    }
    for field in ["input", "output"] {
        if observation.get(field).is_some_and(|v| !v.is_null()) {
            observation[field] = json!({"omitted": true});
        }
    }
    observation["truncated"] = json!(true);
}

/// Size bounds only. Values are kept verbatim (no key- or pattern-based redaction).
fn bound(value: &Value, depth: usize, truncated: &mut bool) -> Value {
    if depth >= MAX_DEPTH {
        *truncated = true;
        return json!("[max-depth]");
    }
    match value {
        Value::String(text) => Value::String(bound_str(text, MAX_STRING_BYTES, truncated)),
        Value::Array(items) => {
            if items.len() > MAX_ENTRIES {
                *truncated = true;
            }
            Value::Array(
                items
                    .iter()
                    .take(MAX_ENTRIES)
                    .map(|item| bound(item, depth + 1, truncated))
                    .collect(),
            )
        }
        Value::Object(fields) => {
            if fields.len() > MAX_ENTRIES {
                *truncated = true;
            }
            let mut kept = Map::new();
            for (key, item) in fields.iter().take(MAX_ENTRIES) {
                kept.insert(key.clone(), bound(item, depth + 1, truncated));
            }
            Value::Object(kept)
        }
        _ => value.clone(),
    }
}

fn bound_str(text: &str, limit: usize, truncated: &mut bool) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    *truncated = true;
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &text[..end], text.len() - end)
}

fn copy(from: &Map<String, Value>, to: &mut Map<String, Value>, key: &str, as_key: &str) {
    if let Some(value) = from.get(key).filter(|v| !v.is_null()) {
        to.insert(as_key.into(), value.clone());
    }
}

fn id_key(id: &Value) -> String {
    id.as_str().map_or_else(|| id.to_string(), str::to_string)
}

fn safe_label(value: &str) -> String {
    let label: String = value.chars().take(64).collect();
    if !label.is_empty()
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
    {
        label
    } else {
        "other".into()
    }
}

fn codex_status(status: Option<&str>, phase: &str) -> Option<&'static str> {
    Some(match status {
        Some("inProgress" | "in_progress") => "running",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("declined") => "denied",
        Some("interrupted" | "cancelled") => "cancelled",
        Some(_) => "unknown",
        None if phase == "started" => "running",
        // A completed item without a status says nothing about the tool result.
        None => "unknown",
    })
}

fn claude_kind(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" | "KillShell" | "KillBash" => "shell",
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "NotebookRead" | "LS" => "file",
        "Glob" | "Grep" | "WebSearch" | "ToolSearch" => "search",
        "WebFetch" => "browser",
        _ if name.starts_with("mcp__") => "mcp",
        "unknown" => "unknown",
        _ => "other",
    }
}

fn acp_tool_kind(kind: &str) -> &'static str {
    match kind {
        "execute" => "shell",
        "read" | "edit" | "delete" | "move" => "file",
        "search" => "search",
        "fetch" => "browser",
        "think" | "switch_mode" | "other" => "other",
        _ => "unknown",
    }
}

/// OpenCode titles the call with its tool id (`bash`, `read`, …) and may refine `title` later;
/// the first reported name is kept so an update cannot rename the call.
fn opencode_tool_name(
    update: &Map<String, Value>,
    known: Option<&(String, String)>,
) -> (String, bool) {
    if let Some((name, _)) = known.filter(|(name, _)| name != "unknown") {
        return (name.clone(), true);
    }
    match update
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
    {
        Some(title) => (title.chars().take(256).collect(), true),
        None => ("unknown".into(), false),
    }
}

/// Cursor puts a human description (often the command) in `title`; the tool identity is its ACP kind.
fn cursor_tool_name(
    update: &Map<String, Value>,
    known: Option<&(String, String)>,
) -> (String, bool) {
    if let Some((name, _)) = known.filter(|(name, _)| name != "unknown") {
        return (name.clone(), true);
    }
    match update.get("kind").and_then(Value::as_str) {
        Some(kind) => (safe_label(kind), true),
        None => ("unknown".into(), false),
    }
}
