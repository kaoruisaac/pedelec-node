# Agent Tool Trace fixtures

Replayable Level 1 fixtures, one chain per Provider:

| File | Produced by | Consumed by |
| --- | --- | --- |
| `<provider>.provider.jsonl` | Hand-written Provider protocol frames: `{direction, turn, message}`, where `turn` is the SDK Turn the Worker would hold active | `rust/crates/pedelec-ipc-worker/src/tool_trace_tests.rs` |
| `<provider>.worker.jsonl` | Golden `agent-tool` payloads from the Worker adapter for those frames | `test/agent-tool-trace.test.ts` (TRACE-03) through the fake transport |

The Rust test fails when the golden drifts. After an intentional adapter change, regenerate and review the diff:

```bash
UPDATE_TOOL_TRACE_GOLDEN=1 cargo test -p pedelec-ipc-worker tool_trace --manifest-path rust/Cargo.toml
```

`{{SESSION_ID}}` stands for the SDK Session id; the SDK test substitutes it so `pedelec-cli --thread-id` matches.

## Provenance: these are not real Provider captures

No frame here was captured from a real Provider run (the MD01 real-Provider run was not executed; see the evidence
report). Each chain follows the shapes below. Field names a real run may contradict are adapter risks, tracked as
real-Provider QA items.

| Provider | Shape source | Known uncertainty |
| --- | --- | --- |
| Codex | Codex App Server v2 `item/started` / `item/completed` `ThreadItem` (`commandExecution` with `command`, `cwd`, `status`, `exitCode`, `aggregatedOutput`; `fileChange`, `mcpToolCall`, `webSearch`), and `*/requestApproval` | Item types added in later Codex versions map to `unknown` + `PROVIDER_ITEM_UNCLASSIFIED` |
| Claude | Claude Code stream-json `assistant` `tool_use` and `user` `tool_result` with `tool_use_result`; Bash result keys (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`) confirmed from local Claude Code transcript key names only (no values) | No numeric exit code exists in the protocol |
| OpenCode | ACP `session/update` `tool_call` / `tool_call_update`, `session/request_permission` | `rawOutput.metadata.exit` is assumed to be OpenCode's numeric exit field |
| Cursor | Same ACP envelope, Cursor-style titles (command in backticks), no `rawInput`/`rawOutput` | Real Cursor payloads may carry more; the adapter reports what is absent |
| Antigravity | `step_update` / `result` stream events as handled by `pedelec-runtime`; step types `run_command` / `view_file` are hypothetical | No verified tool-call identity, so no tool records are produced (capability probe only) |

## 01A event-first golden semantics

Worker goldens were regenerated for 01A: no `redacted` field and no `[REDACTED]` values (fake canaries such as
`sk-proj-…`, `sk-test-SECRET…`, `plain-secret-value`, `/Users/alice/…` are deliberately delivered verbatim), and every
provider frame — including a duplicated one — is its own observation. All credential-looking values in these files are
fake test canaries.
