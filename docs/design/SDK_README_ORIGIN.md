# @pathcraft/pedelec-node

> **MD20（2026-11-05，Mac 本地 Coding PASS，獨立 QA 待驗）：** Runtime Kit 的 `scope`／`role` 已刪除，公開 `sdk.attachSession(input)` 換成 `sdk.resumeSession(sessionId)`。 不加入任意 `metadata`；Host 自己管理 Owner/Role/Workspace/Task、Monitor binding。真 Provider、Windows、Hosted 尚非 Release Ready。
>
> **MD23（2026-11-06）：** SDK 不再寫 Session JSON，`sessionStateDirectory` 已移除。同一 Runtime 的最近 50 個 ended Handle 可 Resume；跨 Runtime 一律 `SESSION_NOT_ACTIVE`。

> **2026-11-05 MD19 現況（覆蓋下方與此不符的描述）：** 六個 Provider 的 Host Tool 全走 `pedelec-cli`，`hostTools` 表示 CLI 回路已在程式接好，不代表真 Provider 已驗收；Worker 的 `tool-reply` 回 `UNSUPPORTED_IN_CLI_MODE`，MCP Bridge 已刪。Provider Artifact 由 SDK 在 `runtimeStorageRoot` 下落地，`onArtifact` 在驗證與原子 rename 完成後通知。原始 `artifact.path` 是短期絕對路徑，需長期保存時由 Host 複製到業務目錄。 傳送失敗回 `ARTIFACT_STORAGE_FAILED`，不影響 Turn。輸入附件無上游路徑，`sendText` 收到 `attachments` 會拒絕。全部 IMPLEMENTED / UNVERIFIED，見 `implementation/Archived/provider-sdk-completion/19_PROVIDER_CLI_TOOL_SDK_COMPLETION.md` §10。
>
> **2026-11-05 CLI transport 優先更新：** Host tools 唯一正式入口為 Provider shell 的 `pedelec-cli --thread-id <SDK sessionId> tool-spec NAME` / `tool-call NAME '<json_args>'`。SDK `createSession({tools, hostInstructions})` / `onTool` 不變；SDK 為每個 create/resume 建立私有 loopback NDJSON endpoint，Worker 子程序繼承 runtime file 與可信 binary PATH。Codex 不再註冊 Dynamic Tool，也不接受 native Tool reply。下文舊 native Tool / MCP / ACK 驗收描述屬歷史，不構成 CLI Gate B 證據。
>
> Schema 由 SDK Ajv 驗證（未知 keyword / remote ref 拒絕；缺省 `additionalProperties` 正規化為 false），Spec 保留 `argsSchema` 並提供 `schema` / `readSpecCommand` / `callCommand`。JSON args 限 64 KiB，結果限 64 KiB；同一 Turn 可串行多工具，同時 pending 拒絕，同 request ID 只回放相同 identity 的結果。Handler 的 `{success:false,result}` 會成為 CLI `{ok:false,result,error}`，輸送失敗與 outcome-unknown 不重試；`context.assertActive()` 仍是每次業務 effect 前必要檢查。
>
> `npm run build:rust` 含實際 `pedelec-cli`；開發模式的 CLI 與 Worker 配套，打包位置在 `dist-server/assets/bin`。Mac 本地 Rust Worker／Fake Provider 合約與 SDK Tool 已回歸，**真 Provider、Windows、Hosted 仍須依 09 QA 驗收**；早期 `implementation/Archived/reports/16-pedelec-cli-tool-transport.md` 只具歷史參考價值。

Private Node/TypeScript SDK for the Pedelec Rust agent runtime. **Not published to npm.** It is linked into the
Pathcraft repo as an npm workspace (`packages/*`) and bundled into `dist-server/server.mjs` by esbuild.

**Runs on Node (`>=24.22.1 <25`) and Bun (`>=1.4.4 <2`).** The Pathcraft Server uses Bun; `Node` in the package name
is historical. The SDK sticks to `node:*` builtins, so `bun`, `bun:*` and the `Bun` global are rejected by
`npm run check:sdk-boundary`. The same test files run on both: `npm run test:sdk` (Node) and `npm run test:sdk:bun` (Bun).

The Pathcraft Server talks to the agent runtime the same way the original Pedelec SDK did — through
`createSession / sendText / onChat / onTool / cancel / close` — while Rust IPC v1 (NDJSON over stdio,
`requestId`, `op`, `sequence`, worker processes) stays a private transport detail inside this package.

```text
Pathcraft HTTP / WS / Run Driver / Planner / Tool Development
        |  (Owner ACL, DB, Graph, Outcome commit stay here)
server/agent/session/{index.ts, execution-agent-session-port.ts}   <- business adapters
        |
@pathcraft/pedelec-node  (client.ts, session.ts, tools.ts, events.ts, errors.ts)
        '- src/transport/rust-ipc.ts -> rust-ipc-supervisor.mjs      <- private, one worker per session
                |  stdin/stdout NDJSON IPC v1 (8 ops, 1 MiB frames)
        rust/crates/pathcraft-ipc-worker -> pedelec-{runtime,core,shared} -> Codex
```

## Documentation: start here

- **SDK consumer / application developer:** [Developer Guide](docs/DEVELOPER_GUIDE.md) — prerequisites, complete TypeScript example, lifecycle, events, Tool handlers, cancellation, errors, timeouts and limitations. No Rust or IPC knowledge required.
- **Runtime kit maintainer / porting to another product:** [Portability and Maintainer Guide](docs/PORTABILITY_AND_MAINTAINER.md) — SDK + IPC Worker + Rust Runtime as one delivery unit, dependency boundaries, platform packaging and migration checklist. This is a proposed extraction plan, not a published artifact.
- **Safety gate:** SDK P0-01/P0-02 are fixed in code and locally tested (`implementation/Archived/reports/11.md`), but independent QA has not run. This private package is not release-ready.

## Usage

```ts
import { createPedelecRuntime, defineTool } from '@pathcraft/pedelec-node';

const sdk = await createPedelecRuntime({ transport: 'rust-ipc' });
const updateScript = defineTool({ name: 'updateScript', description: 'Sync graph', argsSchema: { type: 'object', properties: {}, required: [] } });
const session = await sdk.createSession({
  provider: 'codex', model, effort,
  workdir: serverResolvedTaskRoot,
  runtimeStorageRoot: serverResolvedRuntimeRoot, // trusted absolute directory independent of the workdir
  hostInstructions: 'Pathcraft role: planner.', // optional, always supplied by Host
  tools: [updateScript],
});
const offTool = session.onTool('updateScript', async (args, ctx) => {
  ctx.assertActive();                      // before every durable effect
  const reply = await serverGraphUpdate(args, ctx);
  return { success: reply.synced, result: reply };   // JSON, including null
});
const offChat = session.onChat(async (content, ctx) => { await persistMessage(content, ctx.turnId); });
const receipt = await session.sendText(prompt, { turnId }); // accepted only — not completed
// ... completion arrives via onChat / onTurnEnded / onError
offChat(); offTool();
await session.close('conversation closed');
await sdk.close();
```

## Public API

| API | Semantics |
| --- | --- |
| `createPedelecRuntime(options)` | Returns a `PedelecNodeClient`. `transport: 'rust-ipc'` (default) spawns the bundled (`dist-server/assets/bin`), dev (`rust/target/<profile>`) or `PATHCRAFT_RUST_WORKER_BIN` worker. A `{ connect() }` transport object is for isolated tests only. |
| `sdk.createSession(input)` | Requires `provider, model, effort, workdir, tools, runtimeStorageRoot`. Accepts optional `sessionId` and `hostInstructions`. The SDK resolves its own artifact and Provider state paths under the supplied root. One Worker per Session. |
| `sdk.peekSessionStatus(sessionId)` | Read-only status of a handle this Runtime holds, retained ended ones included; `null` otherwise. Starts no Worker and contacts no Provider. A snapshot, never an authorization. |
| `sdk.listSessions()` | Every handle this Runtime holds. A technical RAM view; attributing them to anything is the Host's job. |
| `sdk.replaceEndedSession(sessionId)` | Hands a recoverable ended Session to a new owner: synchronously retires the current handle, so a stale reference can neither send nor resume, and returns a new offline handle with the same Provider identity and FIFO position. Refuses anything else. The caller then uses `session.resume()`. |
| `session.isResuming()` | True while `resume()` owns the handle, so another Host path does not dispose it mid-rehydrate. |
| `sdk.resumeSession(sessionId)` | ID-only. Returns the handle this Runtime holds, or `SESSION_NOT_ACTIVE`; reads nothing from disk. Then `session.resume()` rehydrates the **same** Provider Thread. Host checks owner, full completed history and provider identity separately. Never replays an active Turn/Run. |
| `sdk.close()` | Stops Sessions and releases the Client’s storage leases. Later `createSession` returns `CLIENT_CLOSED`. |
| `session.sessionId / providerSessionId / provider / model / effort / workdir` | Read-only identity. `providerSessionId` (provider thread) is never the Pathcraft `sessionId`. |
| `session.getStatus()` | `idle | busy | outcome-unknown | unavailable | ended`. |
| `session.sendText(text, { turnId? })` | `{ accepted: true, sessionId, turnId }` once Rust accepts the turn. Refused unless idle, the turn id is new, and **every declared tool has a handler** (`HANDLER_MISSING`). |
| `session.onChat(fn)` | Once per completed turn with the full assistant message (final message, else concatenated deltas). A throwing/rejecting handler makes the turn `unknown` and the session `outcome-unknown`. |
| `session.onChatDelta(fn)` | Live text increments for UI only; never persist both delta and message. |
| `session.onTool(name, handler)` | One handler per declared tool. Context: `sessionId, turnId, toolCallId, toolName, signal, assertActive()`; no business scope/role. Return `{ success, result }` via CLI endpoint; a failed dispatch never silently retries. |
| `session.onAgentToolEvent(listener)` | Read-only, event-first Level 1 observation of the Agent's real Tool Invocations (Provider-native Shell/file/search/MCP/… and Host Tools via `pedelec-cli`). Values are **not redacted** (trusted Server consumer; truncation only). Returns an unsubscribe function. Never executes or answers anything; see **Agent Tool Trace** below. |
| `session.onStatus / onError / onTurnEnded / onEnded` | All return an unsubscribe function. `onEnded` is session teardown, never "Run committed". |
| `client.onMonitorEvent(listener)` | Read-only feed of every session of this client. Listener failures are isolated. `data` contains metadata only; prompt, assistant text and Tool payloads are excluded. Redact identifiers before external storage. |
| `session.cancel(reason)` | Aborts the turn signal, marks `outcome-unknown`, sends one `cancel`. Requires an active turn (`NO_ACTIVE_TURN`). |
| `session.close(reason)` / `session.dispose()` | Close stops the Worker and retains a recoverable ended handle in the FIFO. Dispose retires the handle and leaves landed files and Provider state for startup GC. |
| `defineTool({ name, description, argsSchema })` | Frozen Host-defined descriptor (0～64 per session). Role authorization stays in the Host Server; Rust has no Pathcraft Tool or role allowlist. |

### Turn and callback state machine (single implementation: `src/session.ts`)

- One active turn per session; multiple sequential tool callbacks per turn, each uniquely correlated by `(sessionId,turnId,toolCallId)` and never retried. An acknowledged call returns the session to a state where another tool can run within the same turn.
- A tool request is dispatched only when it matches the active turn, a safe `toolCallId`, a declared tool with a
  handler, no cancel, and a never-seen `[sessionId, turnId, toolCallId]`. Anything else → refused, no reply,
  `outcome-unknown`, `onError('TOOL_REQUEST_REJECTED')`.
- After the handler: if cancel/close/turn change happened meanwhile, the result may exist but is **not** ACKed.
  Results must be bounded JSON (≤ 64 KiB) or the turn becomes unknown. The ACK must echo
  `{acknowledged:true, turnId, toolCallId}`; anything else → `TOOL_ACK_UNKNOWN`.
- Turn terminal: `completed` only when the provider completed and no callback is unknown and no cancel was
  requested; `failed` / `interrupted` mirror the provider; everything else is `unknown`. Non-completed turns leave
  the session `outcome-unknown`.
- Per-session events are processed strictly in order; when a `sequence` is present it must increase
  (`EVENT_SEQUENCE_REVERSED` otherwise). Sessions never share sequences or listeners.

### Errors and timeouts

`PedelecError.code`: `INVALID_INPUT, UNSUPPORTED_PROVIDER, DUPLICATE_SESSION, SESSION_BUSY,
DUPLICATE_TURN, NO_ACTIVE_TURN, HANDLER_MISSING, SESSION_NOT_ACTIVE, TRANSPORT_UNAVAILABLE, PROVIDER_REJECTED,
OUTCOME_UNKNOWN, CLIENT_CLOSED`. `transportCode` keeps the Rust/IPC code (for example `IPC_TIMEOUT`) for diagnostics.

`onError` categories: `TRANSPORT_FAILURE, WORKER_CRASHED, PROVIDER_ERROR, EVENT_SEQUENCE_REVERSED,
TOOL_REQUEST_REJECTED, TOOL_HANDLER_FAILED, TOOL_RESULT_INVALID, TOOL_ACK_UNKNOWN, CHAT_HANDLER_FAILED,
ARTIFACT_STORAGE_FAILED, ARTIFACT_HANDLER_FAILED`, each with a
fixed sanitised message (no stderr, secrets or host paths).

Timeouts: open/resume Provider rehydrate 120 s, send/cancel 30 s, tool handler 90 s (`sendTimeoutMs`, `toolReplyTimeoutMs`); close 2 s.
A timeout is **never retried**: send → `OUTCOME_UNKNOWN`, tool-reply → `TOOL_ACK_UNKNOWN`. Worker crash or protocol
failure → `outcome-unknown` (active turn) or `unavailable` (idle). There is **no fixed active Session count ceiling** in either the SDK or the Rust IPC Worker.
The SDK retains **at most the 50 most recently ended, recoverable technical Session records** (FIFO by end time, including across restarts). Eviction removes only SDK-private reattach metadata/ended handles: a pruned Session cannot be resumed via the SDK, but its Provider history, Artifacts, Workspace and Run data are not deleted. Idle/busy/unknown/unavailable sessions are not FIFO candidates. Other Rust input limits remain authoritative: 128-byte ids, 1 MiB frames, 512 KiB text, 64 KiB tool result, **64 Host-defined tools**, each reached through `pedelec-cli` in the Provider's own shell.

## Agent Tool Trace (`session.onAgentToolEvent`)

```ts
const off = session.onAgentToolEvent((event: AgentToolEvent) => {
  // Frozen, JSON-serialisable fact. Persist/analyse it in the Host; the SDK keeps no trace store.
});
session.onTool('updateScript', async (args, ctx) => ({ success: true, result: { accepted: true } })); // unchanged
off();
```

> **Contract: 01A event-first (2026-11-09).** Supersedes the MD01 redaction, dedupe, global Tool Record and synthetic
> terminal rules. Old → new: no `[REDACTED]`/`detailRedacted` (values verbatim); no SDK dedupe (repeated Provider frames
> are delivered again); no `finished/unknown` synthesised at Turn end, cancel, close or crash; no `maxRecords` Tool
> Record map; Host events are always `correlation: 'unlinked'` (no command-text parent matching).

- **Scope (Level 1).** Events for each Tool frame the Provider *exposes*: the outer Bash/Shell call is one Tool;
  commands inside a script, browser clicks inside `agent-browser`, network and syscalls are not observed. No reasoning,
  chat or raw protocol frame is part of an event.
- **Sources.** `provider-native`: parsed by the Rust Worker from the Provider protocol it already reads (Codex App
  Server items, Claude stream-json `tool_use`/`tool_result`, ACP `tool_call`/`tool_call_update` with separate OpenCode
  and Cursor parsers). `pedelec-host`: emitted by the SDK inside the unchanged `pedelec-cli` → `onTool` path, including
  `tool-call` requests refused before any handler ran. Neither depends on `detailedMonitoring` or `PATHCRAFT_MONITOR_DETAILS`.
- **Event-first.** Each Provider `started`/`updated`/`finished` frame becomes exactly that event, in arrival order, with a
  Session-wide increasing `sequence`. A call seen only as `finished` is delivered as is. A frame the Provider really sent
  twice is delivered twice (the Worker never captures one frame twice); consumers may dedupe by `toolCallId` + `kind` +
  `sequence` order. The SDK keeps **no Tool Record state**: it does not infer missing phases, does not correct
  `started → updated`, and never closes a Tool on Turn end, cancel, close or crash. A Turn terminal is not evidence about
  its Tools; "no `finished` seen" means "not observed", and the consumer decides what that implies.
- **Identity.** `toolCallId` is deterministic: `native:`/`host:` + hash(Session, Turn, source, native/Host id). The same
  native id in the same Turn always yields the same id; another Session or Turn never does. If the Turn is unknown,
  foreign or missing, or the Provider sent no native id, each event gets its own random id with `coverage: 'partial'`
  and `unavailable: ['turnId' | 'nativeToolCallId']` — never merged on `turnId: null`. `lateObservation: true` marks a
  native event naming a Turn of this Session that has already ended. `parentToolCallId` is set only when the Provider
  frame names its parent explicitly (Claude sub-agent `parent_tool_use_id`).
- **Host Tools.** Events come from the invocation-local context of one `onTool` call (no cross-Turn history):
  `started` (args) → `updated` (handler returned) → `finished`, or a single `finished` for a refused request. A returned
  handler ≠ a written CLI reply ≠ a Provider ACK: `output.delivery` is `cli-reply-written` (CLI path) with
  `providerAcknowledgement: 'unavailable'`, or `transport-acknowledged` only when the transport ACKed. Denied, failed,
  timeout (`unknown`, `TOOL_TIMEOUT`) and cancelled outcomes are traced without changing the handler's result. Native
  Shell and Host are two separate sources; Host events are `correlation: 'unlinked'` because the `pedelec-cli` protocol
  carries no trusted parent id. Native Shell events may list `hostInvocations` (`tool-call`/`tool-spec` recognised in
  *that* event's command) as a hint only. `tool-spec` never creates a Host event.
- **Unknown, never invented.** `status`, `exitCode`, input and output appear only when that frame carried them.
  `exitCode` only when the Provider reported a number (Claude and Cursor do not); no result → no `completed`.
  Missing fields are listed in `unavailable`. Adapter-side protocol ID caches (Claude `tool_use_id → name`, ACP
  `toolCallId → title/kind`, pending approvals) are hard-capped at 1,024 entries each with FIFO eviction; an evicted
  entry yields `toolName: 'unknown'` + `unavailable: ['toolName']`, never a guess.
- **Gaps.** `observation-gap` only for real loss or limitation: a non-`supported` adapter (once per Turn:
  `PROVIDER_TRACE_UNSUPPORTED` / `PROVIDER_TRACE_COVERAGE_UNKNOWN`), Worker trace failures (`TRACE_PARSE_FAILED`,
  `TRACE_EMIT_FAILED` with `droppedObservations`, `OBSERVATION_TOO_LARGE`), SDK normaliser failure
  (`TRACE_INSTRUMENTATION_FAILED`), listener overflow (`LISTENER_QUEUE_OVERFLOW`), Antigravity unclassified steps, and
  stream interruption (`TRACE_STREAM_ENDED` on Worker crash / transport failure / fault, or close during a running Turn).
  A normal Turn end or an idle close adds no gap.
- **Fault isolation.** Trace parse panics, oversized or failed trace emits and failed gap emits are contained in the
  Worker tracer: they never stop the Provider event pump, a Tool reply/ACK or a Turn terminal (fault-injection tested for
  Codex, Claude, OpenCode, Cursor and Antigravity). A failed gap is never retried recursively; its count is reported by
  the next deliverable gap. If the shared IPC writer itself is broken, the next business frame fails and the existing
  fault contract applies — the trace never reports that as success.
- **Coverage.** The Worker receipt declares each adapter (`supported` for Codex/Claude/OpenCode/Cursor; `unsupported` for
  Antigravity and Ollama). `supported` is a source-level declaration, not real-Provider QA.
- **Listener isolation.** Events are bounded and frozen before queueing, then delivered asynchronously on one bounded
  queue per listener (`AGENT_TOOL_TRACE_LIMITS.queuePerListener` = 256; a promise is awaited at most 10 s). A slow,
  throwing or rejecting listener only loses its own events and then receives one `observation-gap`
  (`LISTENER_QUEUE_OVERFLOW`, `droppedEvents`, `droppedSequences`) exactly where they were. No Tool, ACK, Turn or Worker
  path waits on a listener. Only listeners registered at publish time receive an event; nothing is replayed, durable or
  exactly-once. `unsubscribe()` stops delivery immediately; re-entrant subscribe/unsubscribe is safe.
- **No redaction — truncation only.** Commands, args, stdout/stderr, output, titles, tool names, paths, URLs, tokens and
  credentials are delivered as the Provider/Handler reported them. `onAgentToolEvent` is for a **trusted Server
  consumer**; being a public SDK API does not make the data safe to expose. The consumer owns ACL, display/API redaction,
  logging, persistence and retention. (The Monitor's own redaction is unchanged.) Limits — resource protection, not data
  safety: command 4 KiB, other strings 4 KiB, stdout 8 KiB, stderr 8 KiB, input 16 KiB, output 24 KiB, event 64 KiB,
  depth 6, 64 entries per object/array; Worker: 32 KiB per string, 192 KiB per observation, 1 MiB IPC frame. Cut text ends
  with `…[truncated N bytes]`, oversized sections become `{ preview, truncated: true }` or `{ omitted: true }`, and every
  cut sets `detailTruncated`. `detailRedacted` is reserved and no longer produced.

## Parity with the original Pedelec SDK

| Original (`@kaoruisaac/pedelec`, Browser) | `@pathcraft/pedelec-node` (Server) |
| --- | --- |
| `workspace.handle.createSession({ provider, model, effort, skills: { tools } })` | `sdk.createSession({ provider, model, effort, workdir, tools, runtimeStorageRoot })` |
| `pedelec().resumeSession(id)` | `sdk.resumeSession(sessionId)` (ended → offline ended handle; Host decides eligibility) |
| `session.sendText(text)` | `session.sendText(text, { turnId })` → `accepted` receipt |
| `session.onChat((content, ctx) => …)` | same; `ctx.turnId`, `ctx.eventEmittedAt` |
| `session.onTool(name, (args, ctx) => value)` | `session.onTool(name, (args, ctx) => ({ success, result }))` + `ctx.assertActive()` / `ctx.signal` |
| `session.onStatus / onError / onEnded` | same, plus `onChatDelta`, `onTurnEnded` |
| `session.getStatus()` | same |
| `session.end()` | `session.close(reason)` (clean ended technical identity can be reactivated) |
| `session.resume()` | `session.resume()` (explicit ended → idle; exact Provider ID only, no Turn replay) |
| `defineTool({ name, description, argsSchema })` | same (descriptor only) |
| `runtimeFullAccess`, Browser workspace path | removed: workdir is a Server-resolved absolute Task root; Full Access risk unchanged |

## Old → new import map

| Before | After |
| --- | --- |
| `server/agent/ipc/rust-worker.mjs` (`RustIpcSupervisor`, `AgentIpcClient`) | `packages/pedelec-node/src/transport/rust-ipc-supervisor.mjs` (SDK-private; tests via `@pathcraft/pedelec-node/transport/rust-ipc-supervisor`) |
| `AgentIpcFactory` / `workerFactory` option on the Session Ports | `AgentRuntimeSource` / `{ runtime }` (a `PedelecNodeClient`) |
| `services.agentIpcFactory` in `createServer` | `services.agentRuntime` |
| `pathcraft doctor` → `RustIpcSupervisor.start()` | `probeRustIpcWorker()` |

## Known limitations

- Six Provider adapters are wired in code, but native/CLI/Provider-specific rehydrate must be verified per platform and Provider.
- Public `resumeSession(id)` only returns a handle held in RAM; `session.resume()` explicitly rehydrates the original Provider ID. The newest 50 confirmed `ended` handles are retained by end order. A disposed, evicted or replaced handle is retired for good. SDK maintains technical safety, while Pathcraft Host checks Owner/Role/Workspace/Preference/Tools/Turn history before reactivation. Rust `resume-provider` remains private; no Turn replay and no Execution Run Crash Resume.
- FIFO eviction collects the ended Session’s landed Artifact and Ollama state. The next Runtime sweeps verified older Instances when it first uses each root. A root with a live owner or writer refuses a competing bind. The SDK supports several roots in a single Client.
- Tools are supplied by the Host as dynamic descriptors; Pathcraft Server loads Pedelec-style `tools.json` manifests at Session creation/resume. Manifest edits affect new Sessions, not already-running Sessions.
- Fake transports may omit `sequence`; the production Rust transport always sends it and the supervisor also enforces it.
- The SDK provides no idempotency or commit: first-commit-wins and DB transactions stay in the Server.
- Agent Tool Trace adapters are verified against protocol fixtures, fake Provider processes and fault injection;
  real-Provider Level 1 coverage is recorded per Provider/OS in the MD01/01A evidence reports. Antigravity (no verified tool identity in
  `step_update`) and Ollama/`pedelec-agent` (Backlog PN-B001) are `unsupported`.

## Checks

```bash
cargo build -p pathcraft-ipc-worker -p pedelec-agent -p pedelec-cli --manifest-path rust/Cargo.toml
npm run typecheck:sdk
npm run test:sdk
npm run check:sdk-boundary
```


Provider integration: `PedelecProvider` includes Codex, Claude, OpenCode, Cursor,
Ollama and Antigravity, all wired to the same CLI Host Tool path. The Worker open
receipt must confirm runtime capabilities, and a session with Tools must also see
`cli-tool-transport`. Compiled operations prove neither runtime availability nor a
real Provider run: all six are IMPLEMENTED / UNVERIFIED. Antigravity cancellation is
`process-stop` and retires the session; attach requires exact native identity and
never replaces a failed session.
