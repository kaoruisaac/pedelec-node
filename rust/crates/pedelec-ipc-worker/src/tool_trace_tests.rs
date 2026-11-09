//! Provider fixture replay for the Level 1 tool-trace adapters.
use crate::tool_trace::*;
use pedelec_runtime::ProtocolTrafficRecord;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Unit tests set faults explicitly; never inherit `PEDELEC_TOOL_TRACE_FAULT` from a parallel test.
fn clean_tracer(provider: TraceProvider) -> ToolTracer {
    let mut tracer = ToolTracer::new(provider);
    tracer.faults = TraceFaults::default();
    tracer
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures/agent-tool")
}

/// Replays a provider frame fixture exactly as a pump would: one record at a time with the
/// Worker's active SDK turn, then the turn-end hook. Returns every `agent-tool` payload.
fn replay(provider: &str, trace: TraceProvider) -> Vec<Value> {
    let text = std::fs::read_to_string(fixture_dir().join(format!("{provider}.provider.jsonl")))
        .expect("fixture");
    let mut tracer = clean_tracer(trace);
    let mut out = Vec::new();
    let mut last_turn: Option<String> = None;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let frame: Value = serde_json::from_str(line).expect("fixture line");
        let turn = frame["turn"].as_str().map(str::to_string);
        let record = ProtocolTrafficRecord {
            ts: "2026-11-09T00:00:00.000Z".into(),
            direction: frame["direction"].as_str().unwrap().into(),
            kind: "event".into(),
            thread_id: Some("s".into()),
            message: frame["message"].clone(),
            unmatched: false,
        };
        out.extend(tracer.observe(&record, turn.as_deref()));
        last_turn = turn;
    }
    out.extend(tracer.turn_finished(last_turn.as_deref()));
    // Golden Worker output, replayed by the SDK fixture tests through the fake transport.
    let golden = fixture_dir().join(format!("{provider}.worker.jsonl"));
    let rendered: String = out.iter().map(|v| format!("{v}\n")).collect();
    if std::env::var("UPDATE_TOOL_TRACE_GOLDEN").as_deref() == Ok("1") || !golden.exists() {
        std::fs::write(&golden, &rendered).expect("write golden");
    } else {
        // Compare JSONL records rather than platform-specific line endings.
        // Keep both event values and their order under strict golden verification.
        let expected: Vec<Value> = std::fs::read_to_string(&golden)
            .expect("read golden")
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid golden JSONL"))
            .collect();
        assert_eq!(
            expected,
            out,
            "{provider} worker golden drifted; rerun with UPDATE_TOOL_TRACE_GOLDEN=1 and review"
        );
    }
    out
}

fn by_id<'a>(out: &'a [Value], id: &str) -> Vec<&'a Value> {
    out.iter().filter(|v| v["nativeToolCallId"] == id).collect()
}

/// 01A raw fidelity: a fake credential / private path the provider reported reaches the
/// observation verbatim (no redaction; untruncated).
fn delivered_verbatim(out: &[Value], canary: &str) {
    assert!(
        out.iter().any(|v| v.to_string().contains(canary)),
        "canary {canary} was not delivered verbatim"
    );
    for v in out {
        assert!(
            !v.to_string().contains("[REDACTED]"),
            "worker redacted a value: {v}"
        );
        assert!(
            v.get("redacted").is_none(),
            "worker no longer reports redaction: {v}"
        );
    }
}

#[test]
fn codex_items_map_to_lifecycle_with_reported_fields_only() {
    let out = replay("codex", TraceProvider::Codex);
    let ok = by_id(&out, "call_ok");
    assert_eq!(ok.len(), 2, "outputDelta is not a separate observation");
    assert_eq!(ok[0]["phase"], "started");
    assert_eq!(ok[0]["toolKind"], "shell");
    assert_eq!(ok[0]["input"]["command"], "/bin/zsh -lc 'echo trace-ok'");
    assert!(ok[0].get("exitCode").is_none());
    assert_eq!(ok[1]["phase"], "finished");
    assert_eq!(ok[1]["status"], "completed");
    assert_eq!(ok[1]["exitCode"], 0);
    assert_eq!(ok[1]["output"]["output"], "trace-ok\n");
    assert!(
        ok[1]["unavailable"]
            .as_array()
            .unwrap()
            .contains(&json!("stdout")),
        "aggregated output is not split stdout"
    );
    let fail = by_id(&out, "call_fail");
    assert_eq!(
        fail.len(),
        3,
        "a duplicated provider frame is forwarded as its own observation (event-first)"
    );
    assert_eq!(fail[1]["status"], "failed");
    assert_eq!(fail[1]["exitCode"], 1);
    let patch = by_id(&out, "call_patch");
    assert_eq!(patch[1]["toolKind"], "file");
    assert_eq!(patch[1]["input"]["changes"][0]["kind"], "add");
    let mcp = by_id(&out, "call_mcp");
    assert_eq!(mcp[0]["toolName"], "search_docs");
    assert_eq!(mcp[0]["toolKind"], "mcp");
    assert_eq!(
        mcp[0]["input"]["arguments"]["api_key"], "sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456",
        "sensitive-looking keys are no longer redacted"
    );
    let web = by_id(&out, "call_web");
    assert_eq!(
        web[1]["status"], "unknown",
        "a completed item without status has no known tool result"
    );
    let rm = by_id(&out, "call_rm");
    assert_eq!(rm[0]["phase"], "updated");
    assert_eq!(rm[0]["status"], "denied");
    assert_eq!(rm[0]["errorCode"], "PROVIDER_APPROVAL_DECLINED");
    assert_eq!(rm[1]["status"], "denied");
    assert!(rm[1]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("exitCode")));
    let future = by_id(&out, "call_future");
    assert_eq!(future[0]["toolKind"], "unknown");
    assert_eq!(future[0]["toolName"], "futureTool");
    assert_eq!(future[0]["errorCode"], "PROVIDER_ITEM_UNCLASSIFIED");
    assert_eq!(by_id(&out, "call_orphan")[0]["phase"], "finished");
    assert_eq!(by_id(&out, "call_hang").len(), 1);
    assert!(
        by_id(&out, "msg_1").is_empty(),
        "agent messages are not tools"
    );
    delivered_verbatim(&out, "sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456");
    delivered_verbatim(&out, "/Users/alice/work/task-1");
}

#[test]
fn claude_tool_use_and_result_pair_by_id_without_inventing_exit_codes() {
    let out = replay("claude", TraceProvider::Claude);
    assert!(out.iter().all(|v| v["providerEvent"] != "stream_event"));
    let ok = by_id(&out, "toolu_ok");
    assert_eq!(ok.len(), 2, "partial stream_event frames are ignored");
    assert_eq!(ok[0]["toolName"], "Bash");
    assert_eq!(ok[0]["toolKind"], "shell");
    assert_eq!(ok[0]["input"]["command"], "echo trace-ok");
    assert_eq!(ok[1]["status"], "completed");
    assert_eq!(ok[1]["output"]["stdout"], "trace-ok");
    assert!(ok[1].get("exitCode").is_none());
    assert!(ok[1]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("exitCode")));
    let fail = by_id(&out, "toolu_fail");
    assert_eq!(fail.len(), 3);
    assert_eq!(fail[2]["status"], "failed");
    assert_eq!(fail[2]["errorCode"], "PROVIDER_TOOL_ERROR");
    assert!(
        fail[2].get("exitCode").is_none(),
        "'Exit code 1' text is never parsed into exitCode"
    );
    assert!(fail[2]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("stdout")));
    assert_eq!(by_id(&out, "toolu_read")[0]["toolKind"], "file");
    assert_eq!(by_id(&out, "toolu_grep")[0]["toolKind"], "search");
    let child = by_id(&out, "toolu_child");
    assert_eq!(child[0]["parentNativeToolCallId"], "toolu_task");
    assert_eq!(child[1]["parentNativeToolCallId"], "toolu_task");
    assert_eq!(by_id(&out, "toolu_sleep")[1]["status"], "cancelled");
    let secret = by_id(&out, "toolu_secret");
    assert_ne!(secret[0]["input"]["env"]["API_KEY"], "[REDACTED]");
    let orphan = by_id(&out, "toolu_never_started");
    assert_eq!(orphan[0]["toolName"], "unknown");
    assert!(orphan[0]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("toolName")));
    assert_eq!(by_id(&out, "toolu_hang").len(), 1);
    delivered_verbatim(&out, "plain-secret-value");
}

#[test]
fn opencode_acp_updates_keep_identity_and_permission_denial() {
    let out = replay("opencode", TraceProvider::OpenCode);
    let ok = by_id(&out, "call_ok");
    assert_eq!(
        ok.iter()
            .map(|v| v["phase"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["started", "updated", "finished"]
    );
    assert!(
        ok.iter().all(|v| v["toolName"] == "bash"),
        "a refined title never renames the call"
    );
    assert_eq!(ok[2]["exitCode"], 0);
    assert_eq!(ok[1]["input"]["rawInput"]["command"], "echo trace-ok");
    let fail = by_id(&out, "call_fail");
    assert_eq!(fail[1]["status"], "failed");
    assert_eq!(fail[1]["exitCode"], 1);
    assert_eq!(by_id(&out, "call_read")[0]["toolKind"], "file");
    let rm = by_id(&out, "call_rm");
    assert_eq!(rm[1]["phase"], "updated");
    assert_eq!(rm[1]["status"], "denied");
    assert_eq!(rm[2]["status"], "failed");
    let orphan = by_id(&out, "call_orphan");
    assert_eq!(orphan[0]["phase"], "finished");
    assert!(orphan[0]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("toolName")));
    let anonymous: Vec<_> = out
        .iter()
        .filter(|v| v["nativeToolCallId"].is_null())
        .collect();
    assert_eq!(anonymous.len(), 1);
    assert_eq!(anonymous[0]["toolKind"], "browser");
    assert!(anonymous[0]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("nativeToolCallId")));
}

#[test]
fn cursor_is_parsed_separately_and_reports_missing_exit_and_input() {
    let out = replay("cursor", TraceProvider::Cursor);
    let ok = by_id(&out, "tool_ok");
    assert_eq!(
        ok[0]["toolName"], "execute",
        "Cursor's tool identity is its ACP kind, not its title"
    );
    assert_eq!(ok[0]["input"]["title"], "`echo trace-ok`");
    assert_eq!(ok[2]["status"], "completed");
    assert!(ok[2].get("exitCode").is_none());
    assert!(ok[2]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("exitCode")));
    assert_eq!(by_id(&out, "tool_fail")[1]["status"], "failed");
    let read = by_id(&out, "tool_read");
    assert!(read[1]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("output")));
    let cli = by_id(&out, "tool_cli");
    assert_eq!(cli.len(), 2, "an allowed permission adds no denial");
    let rm = by_id(&out, "tool_rm");
    assert_eq!(
        rm[1]["status"], "denied",
        "a cancelled permission prompt is a denial"
    );
}

#[test]
fn antigravity_never_invents_tool_records_and_reports_unclassified_steps() {
    let out = replay("antigravity", TraceProvider::Antigravity);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["phase"], "gap");
    assert_eq!(out[0]["errorCode"], "PROVIDER_STEPS_UNCLASSIFIED");
    assert_eq!(
        out[0]["detail"]["unclassifiedStepTypes"],
        json!({"other": 1, "run_command": 2, "view_file": 1})
    );
    // Only step-type labels are reported; no tool record is invented.
    assert!(out[0].get("nativeToolCallId").is_none());
}

#[test]
fn oversized_detail_is_bounded_and_marked() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    let huge = "x".repeat(400 * 1024);
    let record = ProtocolTrafficRecord {
        ts: "t".into(),
        direction: "provider_to_client".into(),
        kind: "event".into(),
        thread_id: None,
        message: json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"big","name":"Write",
            "input":{"file_path":"a","content":huge,"more":[huge, huge, huge, huge, huge, huge, huge]}}]}}),
        unmatched: false,
    };
    let out = tracer.observe(&record, Some("t1"));
    assert_eq!(out[0]["truncated"], true);
    assert!(serde_json::to_vec(&out[0]).unwrap().len() <= MAX_OBSERVATION_BYTES);
    assert_eq!(
        out[0]["input"],
        json!({"omitted": true}),
        "detail beyond the frame budget is dropped, not cut silently"
    );
    assert_eq!(out[0]["toolName"], "Write");
    // A single long string is cut with an explicit marker.
    let record = ProtocolTrafficRecord {
        ts: "t".into(),
        direction: "provider_to_client".into(),
        kind: "event".into(),
        thread_id: None,
        message: json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"long","name":"Bash",
            "input":{"command": "y".repeat(40 * 1024)}}]}}),
        unmatched: false,
    };
    let out = tracer.observe(&record, Some("t1"));
    assert_eq!(out[0]["truncated"], true);
    assert!(out[0]["input"]["command"]
        .as_str()
        .unwrap()
        .ends_with("…[truncated 8192 bytes]"));
}

#[test]
fn declared_coverage_is_explicit_for_every_provider() {
    for (provider, coverage) in [
        ("codex", "supported"),
        ("claude", "supported"),
        ("opencode", "supported"),
        ("cursor", "supported"),
        ("antigravity", "unsupported"),
        ("ollama", "unsupported"),
    ] {
        assert_eq!(
            declared_coverage(provider)["coverage"],
            coverage,
            "{provider}"
        );
    }
}

// ----------------------------------------------------------------------------------------------
// 01A: raw fidelity, bounded ID caches, fault isolation
// ----------------------------------------------------------------------------------------------

use std::cell::RefCell;
use std::io;

fn rec(direction: &str, message: Value) -> ProtocolTrafficRecord {
    ProtocolTrafficRecord {
        ts: "t".into(),
        direction: direction.into(),
        kind: "event".into(),
        thread_id: None,
        message,
        unmatched: false,
    }
}

fn claude_use(id: &str, name: &str, input: Value) -> ProtocolTrafficRecord {
    rec(
        "provider_to_client",
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}),
    )
}

fn claude_result(id: &str) -> ProtocolTrafficRecord {
    rec(
        "provider_to_client",
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]}}),
    )
}

type FailWhen = Box<dyn Fn(&Value) -> Option<io::ErrorKind>>;

/// Records emits; fails according to the predicate (fault injection without real I/O).
struct ScriptedSink {
    sent: RefCell<Vec<Value>>,
    fail: FailWhen,
}

impl ScriptedSink {
    fn new(fail: impl Fn(&Value) -> Option<io::ErrorKind> + 'static) -> Self {
        Self {
            sent: RefCell::new(Vec::new()),
            fail: Box::new(fail),
        }
    }
    fn ok() -> Self {
        Self::new(|_| None)
    }
}

impl TraceSink for ScriptedSink {
    fn emit_trace(&self, _session: &str, data: Value) -> io::Result<()> {
        if let Some(kind) = (self.fail)(&data) {
            return Err(io::Error::new(kind, "scripted failure"));
        }
        self.sent.borrow_mut().push(data);
        Ok(())
    }
}

#[test]
fn raw_canaries_in_input_output_and_titles_are_not_replaced() {
    let canaries = [
        "Authorization: Bearer FAKE-canary-token-000",
        "Cookie: sid=FAKE-canary-cookie",
        "API_KEY=FAKE-canary-api-key",
        "https://user:FAKE-pass@example.invalid/path?token=FAKE-q",
        "/Users/canary-user/private/dir",
    ];
    let mut tracer = clean_tracer(TraceProvider::Claude);
    let input = json!({"command": canaries.join(" && "), "password": "FAKE-pw", "headers": {"authorization": "FAKE-h"}});
    let out = tracer.observe(&claude_use("c1", "Bash", input.clone()), Some("t1"));
    assert_eq!(
        out[0]["input"], input,
        "input delivered byte-for-byte when untruncated"
    );
    assert_eq!(out[0]["truncated"], false);
    let mut acp = clean_tracer(TraceProvider::OpenCode);
    let title = canaries.join(" ");
    let out = acp.observe(
        &rec(
            "provider_to_client",
            json!({"method":"session/update","params":{"update":{
            "sessionUpdate":"tool_call","toolCallId":"a1","title":title,"kind":"execute",
            "rawInput":{"command":title, "secret":"FAKE-s"}}}}),
        ),
        Some("t1"),
    );
    assert_eq!(
        out[0]["toolName"],
        title.as_str(),
        "ACP title / toolName untouched"
    );
    assert_eq!(out[0]["input"]["rawInput"]["secret"], "FAKE-s");
    let done = acp.observe(
        &rec(
            "provider_to_client",
            json!({"method":"session/update","params":{"update":{
            "sessionUpdate":"tool_call_update","toolCallId":"a1","status":"completed",
            "rawOutput":{"output": canaries[0]}}}}),
        ),
        Some("t1"),
    );
    assert_eq!(done[0]["output"]["rawOutput"]["output"], canaries[0]);
}

#[test]
fn nested_and_wide_objects_are_bounded_and_marked() {
    let mut deep = json!("leaf");
    for _ in 0..12 {
        deep = json!({ "d": deep });
    }
    let wide: serde_json::Map<String, Value> =
        (0..100).map(|i| (format!("k{i}"), json!(i))).collect();
    let mut tracer = clean_tracer(TraceProvider::Claude);
    let out = tracer.observe(
        &claude_use("n1", "Write", json!({"deep": deep, "wide": wide})),
        Some("t1"),
    );
    assert_eq!(out[0]["truncated"], true);
    assert!(out[0].to_string().contains("[max-depth]"));
    assert_eq!(out[0]["input"]["wide"].as_object().unwrap().len(), 64);
}

#[test]
fn every_frame_is_its_own_observation_with_no_dedupe_or_synthetic_terminal() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    let sink = ScriptedSink::ok();
    let started = claude_use("dup", "Bash", json!({"command":"echo 1"}));
    tracer.trace(&sink, "s", &started, Some("t1"));
    tracer.trace(&sink, "s", &started, Some("t1"));
    tracer.trace(&sink, "s", &claude_result("only_finished"), Some("t1"));
    tracer.finish_turn(&sink, "s", Some("t1"));
    let sent = sink.sent.borrow();
    let phases: Vec<_> = sent
        .iter()
        .map(|v| {
            (
                v["nativeToolCallId"].as_str().unwrap(),
                v["phase"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        phases,
        [
            ("dup", "started"),
            ("dup", "started"),
            ("only_finished", "finished")
        ]
    );
    assert!(sent
        .iter()
        .all(|v| v["status"] != "unknown" || v["nativeToolCallId"] == "only_finished"));
}

#[test]
fn id_caches_have_a_hard_cap_and_eviction_is_reported_as_unavailable() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    for i in 0..4150 {
        tracer.observe(
            &claude_use(&format!("u{i}"), "Bash", json!({"command":"true"})),
            Some("t1"),
        );
    }
    assert!(
        tracer.cache_sizes().iter().all(|n| *n <= MAX_TRACKED_IDS),
        "{:?}",
        tracer.cache_sizes()
    );
    assert_eq!(tracer.cache_evictions(), 4150 - MAX_TRACKED_IDS as u64);
    // Oldest evicted: the result can no longer name its tool and says so.
    let old = tracer.observe(&claude_result("u0"), Some("t1"));
    assert_eq!(old[0]["toolName"], "unknown");
    assert!(old[0]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("toolName")));
    // Newest kept.
    let new = tracer.observe(&claude_result("u4149"), Some("t1"));
    assert_eq!(new[0]["toolName"], "Bash");

    let mut acp = clean_tracer(TraceProvider::OpenCode);
    for i in 0..4150 {
        acp.observe(
            &rec("provider_to_client", json!({"method":"session/update","params":{"update":{
                "sessionUpdate":"tool_call","toolCallId":format!("a{i}"),"title":"bash","kind":"execute"}}})),
            Some("t1"),
        );
        acp.observe(
            &rec(
                "provider_to_client",
                json!({"method":"session/request_permission","id":i,
                "params":{"toolCall":{"toolCallId":format!("a{i}")},"options":[]}}),
            ),
            Some("t1"),
        );
    }
    assert!(
        acp.cache_sizes().iter().all(|n| *n <= MAX_TRACKED_IDS),
        "{:?}",
        acp.cache_sizes()
    );
    let partial = acp.observe(
        &rec(
            "provider_to_client",
            json!({"method":"session/update","params":{"update":{
            "sessionUpdate":"tool_call_update","toolCallId":"a0","status":"completed"}}}),
        ),
        Some("t1"),
    );
    assert_eq!(partial[0]["toolName"], "unknown");
    assert!(partial[0]["unavailable"]
        .as_array()
        .unwrap()
        .contains(&json!("toolName")));

    let mut codex = clean_tracer(TraceProvider::Codex);
    for i in 0..4150 {
        codex.observe(
            &rec("provider_to_client", json!({"method":"item/commandExecution/requestApproval","id":i,"params":{"itemId":format!("i{i}")}})),
            Some("t1"),
        );
    }
    assert!(codex.cache_sizes().iter().all(|n| *n <= MAX_TRACKED_IDS));
}

#[test]
fn parse_panic_becomes_a_gap_and_tracing_continues() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    tracer.faults.parse = true;
    let sink = ScriptedSink::ok();
    tracer.trace(&sink, "s", &claude_use("p1", "Bash", json!({})), Some("t1"));
    tracer.faults.parse = false;
    tracer.trace(&sink, "s", &claude_use("p2", "Bash", json!({})), Some("t1"));
    let sent = sink.sent.borrow();
    assert_eq!(sent[0]["phase"], "gap");
    assert_eq!(sent[0]["errorCode"], "TRACE_PARSE_FAILED");
    assert_eq!(sent[1]["nativeToolCallId"], "p2");
}

#[test]
fn emit_failure_is_counted_then_reported_once_without_recursion() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    tracer.faults.emit = true;
    tracer.faults.gap = true;
    let sink = ScriptedSink::ok();
    for i in 0..5 {
        tracer.trace(
            &sink,
            "s",
            &claude_use(&format!("e{i}"), "Bash", json!({})),
            Some("t1"),
        );
    }
    assert!(sink.sent.borrow().is_empty());
    assert_eq!(
        tracer.pending_drops(),
        5,
        "gap failures do not recurse or multiply"
    );
    // Gap channel recovers first: the count is reported, the newer observation is still dropped.
    tracer.faults.gap = false;
    tracer.trace(&sink, "s", &claude_use("e5", "Bash", json!({})), Some("t1"));
    {
        let sent = sink.sent.borrow();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["errorCode"], "TRACE_EMIT_FAILED");
        assert_eq!(sent[0]["detail"]["droppedObservations"], 5);
    }
    assert_eq!(tracer.pending_drops(), 1);
    tracer.faults.emit = false;
    tracer.trace(&sink, "s", &claude_use("e6", "Bash", json!({})), Some("t1"));
    let sent = sink.sent.borrow();
    assert_eq!(sent[1]["detail"]["droppedObservations"], 1);
    assert_eq!(sent[2]["nativeToolCallId"], "e6");
}

#[test]
fn oversized_emit_becomes_identity_gap_and_failed_gap_is_counted() {
    let mut tracer = clean_tracer(TraceProvider::Claude);
    let sink = ScriptedSink::new(|v| (v["phase"] != "gap").then_some(io::ErrorKind::InvalidData));
    tracer.trace(
        &sink,
        "s",
        &claude_use("big", "Bash", json!({})),
        Some("t1"),
    );
    assert_eq!(sink.sent.borrow()[0]["errorCode"], "OBSERVATION_TOO_LARGE");
    assert_eq!(sink.sent.borrow()[0]["nativeToolCallId"], "big");
    let broken = ScriptedSink::new(|_| Some(io::ErrorKind::BrokenPipe));
    tracer.trace(
        &broken,
        "s",
        &claude_use("x", "Bash", json!({})),
        Some("t1"),
    );
    assert_eq!(tracer.pending_drops(), 1);
}

#[test]
fn whole_channel_failure_is_left_to_the_business_path() {
    // trace() has no error to return: a broken writer is not reported as success by the tracer,
    // it is detected by the pump's next business emit (provider-rpc / turn / terminal), which
    // keeps the existing fault contract. Here: the tracer only counts the loss.
    let mut tracer = clean_tracer(TraceProvider::Codex);
    let broken = ScriptedSink::new(|_| Some(io::ErrorKind::BrokenPipe));
    for i in 0..10 {
        tracer.trace(
            &broken,
            "s",
            &rec("provider_to_client", json!({"method":"item/started","params":{"item":{"type":"commandExecution","id":format!("c{i}"),"command":"x"}}})),
            Some("t1"),
        );
    }
    assert_eq!(tracer.pending_drops(), 10);
    assert!(broken.sent.borrow().is_empty());
}
