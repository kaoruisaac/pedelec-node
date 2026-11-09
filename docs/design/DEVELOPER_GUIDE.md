# Pedelec Node SDK — 開發者完整使用指南

> **2026-11-05 MD20 已落碼（Mac 本地驗證；非 Release Ready）：** SDK/IPC 已移除 Host 業務用的 `scope`／`role`，不接受 `metadata` 替代。公開 API 為 `sdk.resumeSession(sessionId)`，不再提供 `attachSession(input)`；建立 Session 不再傳入業務 scope/role。Host 仍獨立管理 Role/Workspace/Task、ACL、Prompt 與 Tool；監控業務標籤由 Host 的 binding 填入。**MD23（2026-11-06）已移除 SDK Session JSON：** 只有同一 Runtime 的 ended Handle 可 Resume，不支援跨 Node Process 恢復。真 Provider／Windows／Hosted 尚未驗收，詳 [MD20](../../../implementation/remaining/20_REMOVE_SCOPE_ROLE_FROM_RUNTIME_KIT.md)。

> **2026-11-05 MD19 現況（覆蓋下方與此不符的描述）：** 六個 Provider 的 Host Tool 全走 `pedelec-cli`，`hostTools` 表示 CLI 回路已在程式接好，不代表真 Provider 已驗收；Worker 的 `tool-reply` 回 `UNSUPPORTED_IN_CLI_MODE`，MCP Bridge 已刪。Provider Artifact 由 SDK 在 `runtimeStorageRoot` 下落地，`onArtifact` 在驗證與原子 rename 完成後通知。原始 `artifact.path` 是短期絕對路徑，需長期保存時由 Host 複製到業務目錄。 傳送失敗回 `ARTIFACT_STORAGE_FAILED`，不影響 Turn。輸入附件無上游路徑，`sendText` 收到 `attachments` 會拒絕。全部 IMPLEMENTED / UNVERIFIED，見 `implementation/Archived/provider-sdk-completion/19_PROVIDER_CLI_TOOL_SDK_COMPLETION.md` §10。
>
> **2026-11-05 CLI transport 優先更新：** Host tools 唯一正式入口為 Provider shell 的 `pedelec-cli --thread-id <SDK sessionId> tool-spec NAME` / `tool-call NAME '<json_args>'`。SDK `createSession({tools, hostInstructions})` / `onTool` 不變；SDK 為每個 create/resume 建立私有 loopback NDJSON endpoint，Worker 子程序繼承 runtime file 與可信 binary PATH。Codex 不再註冊 Dynamic Tool，也不接受 native Tool reply。下文舊 native Tool / MCP / ACK 驗收描述屬歷史，不構成 CLI Gate B 證據。
>
> **2026-11-06 CLI JSON 引號與診斷：** Windows PowerShell **7+** 與 bash/zsh 使用單引號包住原始 JSON，例如 `tool-call configureTool '{"mode":"direct","strategy":"direct-implementation"}'`；Windows PowerShell **5.1** 傳給原生 `.exe` 時需將 JSON 內的 `"` 改為 `\"`，例如 `tool-call configureTool '{\"mode\":\"direct\",\"strategy\":\"direct-implementation\"}'`。不可在 PowerShell 7 使用 5.1 的寫法。`TOOL_JSON_INVALID` 是 CLI 收到的 JSON 語法錯誤（先檢查 Shell 引號），`TOOL_SCHEMA_INVALID` 是通過 JSON 解析但不符合 `tool-spec` schema；缺少 CLI 必要參數或參數結構錯誤仍為 `TOOL_ARGS_INVALID`。Windows 真 PowerShell 測試：`tests/platform/windows-cli-quoting.test.ts`。
>
> Schema 由 SDK Ajv 驗證（未知 keyword / remote ref 拒絕；缺省 `additionalProperties` 正規化為 false），Spec 保留 `argsSchema` 並提供 `schema` / `readSpecCommand` / `callCommand`。JSON args 限 64 KiB，結果限 64 KiB；同一 Turn 可串行多工具，同時 pending 拒絕，同 request ID 只回放相同 identity 的結果。Handler 的 `{success:false,result}` 會成為 CLI `{ok:false,result,error}`，輸送失敗與 outcome-unknown 不重試；`context.assertActive()` 仍是每次業務 effect 前必要檢查。
>
> **2026-11-05 驗收狀態更新：** Mac mini CLI/onTool 9/9 與真 Codex Tool E2E 是 MD17–19 修改前的歷史證據。最新 SDK/Provider/CLI 接線已完成但未跑新的真 Provider／Windows／GUI／Installer 驗證，Capability 由 implementationReady／verified 區分、不能因缺 E2E 直接描述為程式封鎖；參見 implementation/Archived/provider-sdk-completion/19_PROVIDER_CLI_TOOL_SDK_COMPLETION.md §10 與 docs/release/VERIFICATION_BACKLOG.md。

> 版本基準：2026-11-04，`@pathcraft/pedelec-node` 0.1.0（**repo 內 private workspace，未發布 npm**）。
> 本指南以 `src/index.ts`、`client.ts`、`session.ts`、`types.ts` 實際公開介面為準；**不是未來 API 的承諾**。
> **驗收警示：** M0/P0-01/P0-02 已修復並通過本地負向測試（見 `implementation/Archived/reports/11.md`），但第 09 輪獨立 QA、跨平台與真 Provider 驗收尚未完成，**不代表可以發行或跨專案上線**。

## 1. 開發者需要知道什麼

SDK 是 Node.js 或 Bun 上的 TypeScript 程式操作 AI Agent 的**唯一高階入口**。使用者不必建立 IPC Worker、不必收 NDJSON、不必管理 Rust Controller、requestId 或 Provider Process。

~~~text
你的 Node.js／Bun TypeScript 應用程式
  └─ createPedelecRuntime() → sdk
       └─ sdk.createSession() / sdk.resumeSession(sessionId)
            ├─ session.sendText() / cancel() / close()
            ├─ session.onChat() / onChatDelta() / onStatus()
            ├─ session.onTool() / onArtifact() / onError() / onTurnEnded() / onEnded()
            └─ [SDK 內部] Rust IPC Supervisor → Rust Worker → Rust Runtime → Provider
~~~

**責任邊界：** SDK 負責 Session、Turn、Tool Dispatch、狀態、事件、Transport 及清理；**你的應用**仍負責使用者身份與權限、Workspace 的建立／儲存／生命週期、可信工作目錄、持久化、工具副作用與交易、審計、應用層排程。SDK **不會自行建立或管理 Workspace Root**；`createSession({ workdir, runtimeStorageRoot })` 接收的是 Host 已決定的絕對工作目錄，而非 SDK 的固定 Workspace 位置。SDK 不提供沙箱隔離，也不保證 Tool 的交易回滾。

## 2. 前置條件與取得方式（目前版本）

1. **Node.js >= 24.22.1、< 25，或 Bun >= 1.4.4、< 2**。兩邊跑同一批測試（`npm run test:sdk`、`npm run test:sdk:bun`）；SDK 只用 `node:*` 內建模組，不得使用 `bun`、`bun:*` 或 `Bun` 全域，由 `npm run check:sdk-boundary` 把關。本倉庫使用 npm workspaces + TypeScript 原始碼 export，Server 以 esbuild 打包。請使用支援 TypeScript 原始碼的建置／執行環境。
2. 在目前 Pathcraft Desktop repo 執行 `npm install`；套件位於 `packages/pedelec-node/`，應用可從 `@pathcraft/pedelec-node` import。**目前不能直接 `npm install @pathcraft/pedelec-node` 從 npm registry 安裝。**
3. 需備妥與目前作業系統及 CPU 架構相符的 `pathcraft-ipc-worker`（Windows 為 `.exe`）。在此 repo 用 `cargo build -p pathcraft-ipc-worker --manifest-path rust/Cargo.toml` 產出 debug Worker，或 `npm run build:rust` 產出 release Worker；預設 dev 從 `rust/target/debug` 取用，`NODE_ENV=production` 時取 `rust/target/release`。可用 `PATHCRAFT_RUST_WORKER_BIN` 或初始化時的 `rustIpc.binaryPath` 指定**絕對路徑**。發行包由本 repo 的打包腳本放入 `dist-server/assets/bin`。
4. 需要可用的 Provider Runtime，模型與 effort 要由應用程式確認有效值。目前已接線 `codex`、`claude`、`opencode`、`cursor`、`ollama`、`antigravity`；**IMPLEMENTED / UNVERIFIED，不代表六個 Provider 已通過真實 E2E**。以下範例使用 Codex。
5. `workdir` 必須是你的後端已驗證、絕對的工作目錄（不得直接信任瀏覽器提供的路徑）。Workspace/Task/Node 與角色是 Host 業務欄位，不得再傳入 SDK。

### Workspace、Session workdir 與儲存位置

**通用 SDK 契約：** `@pathcraft/pedelec-node` 不決定 Workspace Root，也不管理 Workspace 資料庫、Task 目錄或備份。Host 先建立／確認可信目錄，再將絕對路徑交給 `createSession({ workdir, runtimeStorageRoot })`。Provider 在此工作目錄執行；SDK 不認識 Workspace/Task/Role。

**目前 Pathcraft Desktop / Hosted 的 Host 實作**（不是 SDK 的通用預設）：

~~~text
<DataRoot>/
  shared.sqlite
  workspaces/
    <workspaceId>/                       # Workspace Root（Server-owned）
      .pathcraft/
        pathcraft.sqlite                 # Workspace DB
        skills/planner/<version>/        # Planner Skill
        deletions/                       # Task Delete Journal／quarantine（只在刪除中存在）
      .pedelec-runtime/
        instances/<runtimeInstanceId>/
          artifacts/<sdkSessionId>/.pedelec-staging/<sdkSessionId>/
          provider-state/ollama/<sdkSessionId>/sessions/YYYY/MM/<providerSessionId>/
      <task.folderName>/                # Session workdir；Planner／Developer／Execution Agent 使用 Task Root
~~~

`DataRoot` 由 Pathcraft Server 的啟動方式決定，而非 SDK 推算：

| Pathcraft 執行模式 | DataRoot（Workspace 位於其 `workspaces/<workspaceId>/` 下） |
| --- | --- |
| `npm run tauri dev`（Mac / Windows） | `<pathcraft-desktop repo>/.local/tauri-dev-data/`（開發資料與正式安裝版隔離） |
| macOS 正式 Desktop | `~/Library/Application Support/cc.pathcraft.desktop/data/` |
| Windows 正式 Desktop | `%APPDATA%\Pathcraft\data\` |
| Hosted | 啟動 Server 所指定的 `--data-root` |

路徑優先順序：Tauri Launcher 若有 `PATHCRAFT_DATA_ROOT` 環境變數，會以它覆寫 Desktop 的上述預設；Hosted 依啟動參數決定。Pathcraft Server 依 `task.folderName` 在 Workspace 下解析並驗證 Task Root，再當作 `workdir` 傳給 SDK；不是把整個 Workspace Root 當成所有 Session 的 `workdir`。

Pathcraft Host 傳入可信的 `<WorkspaceRoot>/.pedelec-runtime`。SDK 以 Client Instance ID 與 SDK Session ID 配置子目錄，可在同一 Client 使用多個根。SDK Session ID 與 Provider Thread ID 分開。SDK 只為需要私有 Store 的 Ollama 建立 Provider State。Ollama Worker 缺可信 Store 時拒絕開啟。SDK 使用可攜安全的路徑名稱表示 Session ID，遇到特殊字元、大小寫衝突或 Windows 保留名時使用 SHA-256。

同一 Client 保留最新 50 個 confirmed ended Session。Resume 與 Handle 交接沿用原路徑和 Provider Thread。FIFO 淘汰先退休 Handle，再等 Worker 停止，然後回收兩種技術資料。正常關閉或 `dispose` 保留已落地 Artifact 和 Provider State。Crash、unavailable 或 outcome-unknown 留待重啟。下一個 Client 第一次使用各根時，以 Rust 持有的 OS 檔案鎖確認舊 Instance 無寫入者，再清理能驗證所有權的目錄。舊 Task-scoped 資料及第三方 Home 由原擁有者保管。

程式碼依據：`server/workspace/path-resolver.ts`、`server/agent/session/index.ts`、`server/agent/session/execution-agent-session-port.ts`、`desktop/src-tauri/src/main.rs`、`packages/pedelec-node/src/client.ts`。

### 最小執行範例（事件驅動）

以下程式碼示範 API 本身；`CODEX_MODEL` 請填當前 Provider 支援的實際模型。此例由**可信的本機程式**指定 workdir；若有 HTTP 使用者，請在呼叫 SDK 之前完成權限與路徑審查。

~~~ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPedelecRuntime, defineTool, PedelecError } from '@pathcraft/pedelec-node';

const model = process.env.CODEX_MODEL;
if (!model) throw new Error('Set CODEX_MODEL to an available Codex model');

const sdk = await createPedelecRuntime({
  transport: 'rust-ipc', // default; normally omit this option
  sendTimeoutMs: 30_000,
  toolReplyTimeoutMs: 30_000,
});
try {
  const echo = defineTool({
    name: 'echo',
    description: 'Return an acknowledgement',
    argsSchema: { type: 'object', properties: {}, additionalProperties: true },
  });
  const session = await sdk.createSession({
    provider: 'codex',
    model,
    effort: process.env.CODEX_EFFORT ?? 'default',
    workdir: process.cwd(), // SDK accepts Host-selected absolute Task/working directory; cwd is for this demo only
    runtimeStorageRoot: join(process.cwd(), '.pedelec-runtime'), // choose a dedicated technical root for this demo
    tools: [echo],
  });

  session.onTool('echo', async (_args, ctx) => {
    ctx.assertActive(); // must re-check before each persistent side effect
    return { success: true, result: { echoed: true } };
  });
  session.onChat(async (text, ctx) => {
    console.log('completed assistant text', ctx.turnId, text);
  });
  session.onChatDelta((delta) => console.log('preview delta', delta));
  session.onError((error) => console.error('sdk event error', error.category));
  session.onEnded((reason) => console.log('session ended', reason.reason));

  const turnId = randomUUID();
  const finished = new Promise<'completed' | 'not-completed'>((resolve) => {
    session.onTurnEnded((outcome) => {
      if (outcome.turnId === turnId) resolve(outcome.terminal === 'completed' ? 'completed' : 'not-completed');
    });
    // Crash/transport loss may not produce a normal terminal callback.
    session.onStatus((status, ctx) => {
      if (ctx.turnId === turnId && (status === 'outcome-unknown' || status === 'unavailable')) resolve('not-completed');
    });
  });
  const receipt = await session.sendText('Please respond briefly.', { turnId });
  console.log('accepted, NOT finished', receipt);
  // Production applications also need their own completion deadline.
  console.log('turn result', await finished);
  await session.close('demo finished');
} catch (error) {
  if (error instanceof PedelecError) {
    console.error('SDK code', error.code, 'transport diagnostic', error.transportCode);
  }
  throw error;
} finally {
  await sdk.close(); // idempotent: shuts down remaining sessions and workers
}
~~~

**重點：** `sendText()` resolve 只表示 Provider 接受該 Turn，**不表示生成完成、工具完成或資料已提交**。收到 `onTurnEnded('completed')` 也**不表示你的資料庫交易已成功**：應用層必須自行確認。

## 3. 使用順序與日常操作

1. 在每個後端 Runtime 建立一個 `sdk = await createPedelecRuntime()`；它可持有多個 Session。
2. 由可信 Host 提供動態 Tool 描述（也可以從 Pedelec 風格 `tools.json` 載入），以 `defineTool` 驗證後傳給 `sdk.createSession({ tools })`；支援 **0～64 個 Tool**，不需要修改 Rust Worker。
3. 先註冊**每個**宣告工具的 `session.onTool(name, handler)`，以及需要的聊天、狀態、錯誤、完成事件。
4. 以可追蹤的唯一 `turnId` 送 `sendText(text, { turnId })`，每個 Session 同時只允許一個 Turn；不要重用 Turn ID。
5. 透過事件消費結果。若要再次 `sendText`，必須先確認 Session 回到 `idle`；`outcome-unknown` / `unavailable` **不可自行當作 idle**。
6. 不再使用時 `await session.close(reason)`，Server 停止時 `await sdk.close()`；訂閱函式回傳的解除器可單獨呼叫。

### SDK 公開介面速查

| API | 作用／重要限制 |
| --- | --- |
| `createPedelecRuntime(options?)` | 建立 `PedelecNodeClient`；`transport: 'rust-ipc'` 為預設；`rustIpc` 可配置 `binaryPath/cwd/env/startTimeoutMs`。SDK 不寫 Session JSON。 |
| `sdk.createSession(input)` | 必填 `provider, model, effort, workdir, tools, runtimeStorageRoot`。可選 `sessionId`、`hostInstructions`。Host 驗證並提供兩個獨立的絕對路徑，SDK 配置儲存根下的私有路徑。每個 Session 一個 Worker。 |
| `sdk.peekSessionStatus(sessionId)` | 唯讀查本 Runtime 持有的 Handle 狀態（含保留中的 ended）；沒有回 `null`。不啟動 Worker、不碰 Provider。只是快照，不是授權。 |
| `sdk.listSessions()` | 本 Runtime 持有的全部 Handle，純技術 RAM 檢視；歸屬判斷由 Host 負責。 |
| `sdk.replaceEndedSession(sessionId)` | 把可恢復的 ended Session 交給新擁有者：**同步**使舊 Handle 永久失效（舊引用不能 send／resume），回傳相同 Provider 身份、相同 FIFO 位置的離線新 Handle；其他狀態一律拒絕。之後由呼叫方 `session.resume()`。 |
| `session.isResuming()` | `resume()` 進行中為 true，避免另一條 Host 路徑在 rehydrate 途中 dispose 此 handle。 |
| `sdk.resumeSession(sessionId)` | **只接受 SDK Session ID**；回傳本 Runtime 持有的 Handle（含 ended），沒有則 `SESSION_NOT_ACTIVE`。不讀磁碟、不建新 Thread。不是 Run/Turn 重播。 |
| `sdk.getSession(sessionId)` / `sessionCount` | 僅操作**當前 client 仍持有的 Session Handle**（含保留中的 ended 與尚未關閉的故障 Handle）；不是跨程序索引。沒有固定最大 active Session 數量，但應由 Host 正常 close/dispose 釋放 Worker。 |
| `session.sessionId` / `providerSessionId` | SDK Session 身份與 Provider Thread 身份是**不同的 ID**；其他唯讀屬性為 `provider, model, effort, tools, workdir, runtimeStorageRoot, artifactDirectory, providerStateDirectory, hostInstructions`，沒有 Host 的 scope/role。 |
| `session.getStatus()` / `getActiveTurnId()` | 讀取 SDK 目前狀態及 Turn；SDK Status ≠ 應用 DB/Run 狀態。 |
| `session.sendText(text, { turnId? })` | 返回 `{ accepted: true, sessionId, turnId }`；send timeout 不可自動重試。 |
| `session.cancel(reason)` | 僅有 active Turn 才可呼叫；中止 signal、結果改為 unknown；不表示副作用回滾。 |
| `session.close(reason)` / `dispose()` | Close 結束 Worker，確認可恢復的 Handle 進入 ended FIFO。Dispose 退休 Handle。兩者保留已落地 Artifact 和 Provider State。 |
| `sdk.close()` | 停止 Worker 並釋放 Storage Root 所有權。SDK Session 只存在原 Client 的 RAM。 |
| `sdk.prepareStorageRootDeletion(root)` | Workspace Delete 專用。封鎖該根的開啟／Resume，驗證 Worker 已停止並取得寫入互斥權。Host 確立刪除後呼叫 `seal()`，再走整棵 Workspace 的 quarantine；以 `release()` 結束 guard。 |
| `defineTool(descriptor)` | 定義凍結後的工具描述；不是註冊執行者，需另配 `onTool`。 |
| `PedelecError` / `probeRustIpcWorker` | SDK 錯誤分類；後者僅用於 Worker 启動探測，不是 Session API。 |

## 4. Events 與 callback 契約

| 訂閱 API | Callback 簽章與用途 |
| --- | --- |
| `onChat(fn)` | `(content: string, ctx: PedelecChatContext) => void / Promise<void>`；**completed Turn** 的完整訊息，應用可在這裡持久化。若 handler throw/reject，結果被標為 unknown。 |
| `onChatDelta(fn)` | `(delta: string, ctx) => void`；純 UI 增量，不要和 `onChat` 再次累加持久化。 |
| `onArtifact(fn)` | `(artifact: PedelecArtifact, ctx: PedelecArtifactContext) => void / Promise<void>`；SDK 在 `artifact.path`（短期絕對路徑）就緒後通知。需要長期保存時，Host 在淘汰或重啟前將檔案複製到業務目錄。 |
| `onTool(name, fn)` | `(args: unknown, ctx: PedelecToolContext) => { success: boolean, result: JsonValue }` 或 Promise；SDK 負責 Tool Reply/ACK。 |
| `onStatus(fn)` | `(status, ctx) => void / Promise<void>`；可為 `idle, busy, outcome-unknown, unavailable, ended`。 |
| `onError(fn)` | `(error: { category, message, turnId }, ctx)`；**事件診斷**，不是業務重試通知。 |
| `onTurnEnded(fn)` | `(outcome: {turnId, terminal, providerStatus, cancelRequested, toolCalls}, ctx)`；`terminal` 為 `completed/failed/interrupted/unknown`。 |
| `onEnded(fn)` | `(reason: { reason, at }, ctx)`；Session/Worker 生命結束，**不是 Run 交易完成**。 |

`ctx` 含 `sessionId, provider, turnId, eventEmittedAt`，**不含** Host 的 scope/role。`PedelecChatContext` 多了 `truncated`；Tool Context 多了 `toolCallId, toolName, signal, assertActive()`。各事件註冊方法均回傳 `() => void`，適合在應用離開作用域時解除。狀態是 Snapshot，事件是變化通知；**請勿假設不同回呼代表資料庫提交順序或跨 Session 的全域時間順序**。

### Tool 的正確做法

~~~ts
const off = session.onTool('echo', async (args, ctx) => {
  if (ctx.signal.aborted) throw new Error('turn cancelled');
  ctx.assertActive();
  // If this were a DB write: check owner/ACL and durable idempotency in YOUR app.
  const value = { received: typeof args === 'object' && args !== null };
  ctx.assertActive(); // check again immediately before any durable effect
  return { success: true, result: value }; // JSON (null is also valid)
});
// off() unregisters the tool; do not send another turn until all declared handlers exist.
~~~

- 每個 Turn 可依序處理**多個不同 Tool Call**，每個 `(sessionId, turnId, toolCallId)` 最多執行一次。SDK 不會自動重試 callback/ACK；若 ACK 不確定，可能已發生副作用，**不要再呼叫同一工具補做**。
- 回傳值必須是 `{ success: boolean, result: JSON }`，`result` 必填；大小上限 64 KiB（序列化後）。
- `assertActive()` 是必要的即時檢查，但**不是跨系統交易或 crash-proof 保證**。敏感操作必須由應用加上 ACL、不可重入防護、idempotency key、first-commit-wins 等。
- SDK 已使用 Ajv 對宣告的 Tool Schema 與傳入參數進行結構驗證，但**不會代替 Host 做角色／Workspace／業務授權**；Tool Handler 仍需檢查使用者權限與業務限制。

### 動態 Tool Manifest 與 Host Handler

Pathcraft Server 將 Pedelec 風格的 `tools.json` 存於 `server/agent/tools/manifests/<role>/tools.json`，每次新建／Attach Session 時重新讀取並提供 `tools`。在正式 bundle 中，這些檔案位於 `dist-server/assets/server/agent/tools/manifests/`。SDK 自身不要求檔案路徑：一般開發者可以自行準備合法的 `PedelecToolDescriptor[]`，或先從可信 Manifest 載入。

Tool 名稱、Description、argsSchema、角色可見性與 Handler **均由 Node Host 決定**；Rust Worker 不內建 Pathcraft Tool，也不代替 Host 授權。新增 Manifest Tool 後，Host 必須註冊對應 `session.onTool(name, handler)`，否則首次 `sendText()` 會以 `HANDLER_MISSING` 拒絕。編輯 Manifest 僅影響後續新開／Attach 的 Session，進行中的 Session 不會自動熱更新。本輪不支援 Pedelec 遠端 skills URL 載入、per-tool timeoutMs；兩者尚須獨立決定。

## 5. Session 狀態機與結果解讀

~~~text
建立成功 → idle --sendText--> busy
                             ├─ provider completed + callback 已確認 → idle
                             ├─ failed / interrupted / callback unknown → outcome-unknown
                             ├─ cancel / timeout / provider loss → outcome-unknown
idle --worker loss--> unavailable
任何可用狀態 --close/dispose--> ended
~~~

**`outcome-unknown` 不代表確定失敗：** Provider、Tool 或 DB 副作用可能發生，也可能沒有。SDK 採 no-retry；應由應用查核已提交的業務資料，而非重播 Turn/Tool。若 Runtime Worker 退出且應用 Run 中斷，Pathcraft 現行政策是不恢復、不續跑。**P0-01/P0-02 已完成 Coding 修復與本地負向測試，仍需第 09 輪獨立 QA 後才能判定正式驗收通過。**

### Resume（不重送原 Session 設定）

~~~ts
// Host 先確認所有者、Workspace／Task／Role 權限和 Conversation Turn 均已完成。
const resumed = await sdk.resumeSession(storedSdkSessionId); // 僅限本 Runtime 持有；ended → ended，此時不啟動 Worker
if (resumed.providerSessionId !== storedProviderThreadId) {
  throw new Error('PROVIDER_ID_MISMATCH'); // Host 拒絕，避免對未授權 Session 執行動作
}
// Host 的 Owner／Workspace／Role／歷史 Turn／設定／Tools 檢查必須先完成。
if (resumed.getStatus() === 'ended') await resumed.resume(); // rehydrate 原 Provider ID → idle
resumed.onTool('echo', async () => ({ success: true, result: { echoed: true } }));
~~~

**對齊原版 Pedelec 的兩階段生命週期：** `sdk.resumeSession(id)` 僅取回 RAM 中的 Handle，對可恢復的 `ended` 回傳該 Handle，**不啟動 Worker、不聯絡 Provider**。只有 Host 通過業務檢查並明確呼叫 `session.resume()`，才用原 Provider ID 重新連線並在成功後進入 `idle`；單一 Runtime 的原 `session` handle 在乾淨 `close()` 後亦可呼叫 `session.resume()`。不會補建另一個 Provider Thread 或重播 Turn／Tool。

**不支援跨 Runtime 恢復（MD23）：** SDK 只在 RAM 保留 Handle，Server 重啟後 `resumeSession` 回 `SESSION_NOT_ACTIVE`，不靠 DB 重播、不建新 Thread。SDK 不承擔 Workspace／Task／Role／Preference／Tool Manifest／Conversation 歷史的准入政策。原始 workdir、Tools、Host Instructions、Artifact／Provider State 目錄一律沿用 Handle，`resumeSession(id)` 不接受額外設定；**結束前仍在 busy／outcome-unknown、不確認的狀態保持 fail-closed**。已 dispose、遭淘汰或被 `replaceEndedSession` 取代的舊物件永久失效（`isRetired()`）。一次 Provider rehydrate 失敗後該 Handle 轉 `unavailable`，不再重試。`isWorkerStopped()` 回報 Worker 是否確認已停止，供 Host 判斷故障 Session 是否已收斂。Host 在 `session.resume()` 前須驗證權限、歷史 Turn 與技術配置，恢復後重新綁定 Tool／事件 handlers。Pathcraft Execution Run Crash Resume 仍禁止；真 Provider 重連能力必須分別實測。

## 6. 同步錯誤、非同步錯誤與逾時

- **同步／Promise 拒絕**：攔截 `PedelecError`，使用穩定的 `code` 判斷；`transportCode` 只供受限的診斷。`code` 列舉：`INVALID_INPUT, UNSUPPORTED_PROVIDER, DUPLICATE_SESSION, SESSION_BUSY, DUPLICATE_TURN, NO_ACTIVE_TURN, HANDLER_MISSING, SESSION_NOT_ACTIVE, TRANSPORT_UNAVAILABLE, PROVIDER_REJECTED, OUTCOME_UNKNOWN, CLIENT_CLOSED`。
- **Session 事件**：`onError` category 有 `TRANSPORT_FAILURE, WORKER_CRASHED, PROVIDER_ERROR, EVENT_SEQUENCE_REVERSED, TOOL_REQUEST_REJECTED, TOOL_HANDLER_FAILED, TOOL_RESULT_INVALID, TOOL_ACK_UNKNOWN, CHAT_HANDLER_FAILED, ARTIFACT_STORAGE_FAILED, ARTIFACT_HANDLER_FAILED`；message 經過濾，不附任意 Provider stderr 或敏感路徑。
- **預設逾時**：open/resume 的 Provider rehydrate 最長 120 秒；send/cancel 使用 `sendTimeoutMs = 30_000`；tool handler 使用 `toolReplyTimeoutMs = 90_000`；close 2 秒；Worker spawn 逾時預設 5 秒（`rustIpc.startTimeoutMs`）。**Timeout 不會自動重試**。
- **`HANDLER_MISSING`**：有 Tool 沒註冊；先完成所有 `onTool`。**`SESSION_BUSY`**：Session 不在 idle。**`OUTCOME_UNKNOWN`**：送出是否成功無法確認；不要重新發送相同 Turn 或使用新 ID 假裝沒發生。
- HTTP/WS consumer 不應將任意 `error.message`、原始 Provider Log、Tool Args/Result 或 Host 路徑暴露給外部；保留內部分類、受限告警及應用層錯誤映射。

## 7. 現行硬限制（請依實際程式碼驗收）

| 項目 | 目前限制 |
| --- | --- |
| Provider / Host Role | 六個 Provider 均有 CLI Host Tool 接線，IMPLEMENTED / UNVERIFIED；Planner/Tool Development/Execution Role 僅在 Pathcraft Server 保留，不是 SDK 參數。 Ollama 走同一條 CLI Host Tool 回路；SDK 不依賴 Deno。 |
| Session | 不設固定 active Session 數量上限；每個 active Session 一個 Rust Worker，仍應正常 close/dispose。可恢復的 confirmed `ended` Handle 只在 RAM 保留最新 50 個（依結束順序 FIFO，Resume 中的不淘汰）；超額最舊者永久失效，但不刪 Provider 歷史／Artifact／Pathcraft 業務資料。50 是 RAM 保留量，不是磁碟紀錄上限。 |
| 工具 | **每 Session 0～64 個**，可在同一 Turn 依序呼叫多個已註冊 Tool；不支援現有 Session 的自動熱替換。 |
| IDs | `sessionId` / `turnId` / `toolCallId` 最多 128 bytes；`providerSessionId` 最多 512 bytes。 |
| Prompt / Result | `sendText` UTF-8 最多 512 KiB；Tool result JSON 最多 64 KiB；IPC 單 frame 最多 1 MiB。 |
| Error／Resume | 不保證 exactly-once 交易；未知結果不重試；不公開 `resume-provider`。 |
| 監看 | **預設** `client.onMonitorEvent(listener)` 仍為 metadata-only，不含 Prompt、Assistant 文字或 Tool args/result。只有信任的本機 Desktop Host 明確使用 `createPedelecRuntime({ detailedMonitoring: true })` 時，才會額外收到 `sdk.*` Callback 觀測資料（包含沒有 Host Listener 時 SDK 仍產生的事件；`listenerCount: 0` 表示當下沒有註冊 Listener，不代表已交付；非零計數可能包含 SDK 內部 Listener）、`transport.event`、帶有受限 Payload 的 `provider.rpc` 及 IPC Frame。**SDK 原始詳細內容不保證已遮罩**：Host 必須在 RAM 留存／傳給 UI 前遮罩、限長，且禁止 Hosted/外部公開存取；不要寫入一般 Log。 |
| 發布狀態 | 目前為 Repo 私有套件；尚無獨立版號／Release Artifact／跨專案整合驗收。 |

## 8. 開發／故障排查

在 **Pathcraft Desktop repo 根目錄**執行：

~~~bash
npm install
cargo build -p pathcraft-ipc-worker --manifest-path rust/Cargo.toml  # dev binary
# Or: npm run build:rust  # release binary; configure a matching path/profile
npm run typecheck:sdk
npm run test:sdk
npm run check:sdk-boundary
node bin/pathcraft.mjs doctor
~~~

若找不到 Worker，確認 `rustIpc.binaryPath` / `PATHCRAFT_RUST_WORKER_BIN` 是本平台**絕對路徑**，且二進位可執行。若 `UNSUPPORTED_PROVIDER`，確認 Provider 名稱；若 `PROVIDER_REJECTED`，確認 Worker receipt 含 `cli-tool-transport`；Antigravity 尚未通過工作目錄隔離；若模型被拒絕，應先透過應用層 Provider 能力查詢確認模型與 effort。若 Tool ACK 不明，**先查核應用資料是否已提交，禁止盲目重試**。

## 9. 移植到別的產品時該讀哪份文件？

**一般開發者只讀這份指南與 `README.md`。** Runtime 維護者／整合工程師才需要讀 [`PORTABILITY_AND_MAINTAINER.md`](PORTABILITY_AND_MAINTAINER.md)，瞭解完整交付物、二進位佈署、模組拆分、Pathcraft 耦合與 Release Gate。SDK 使用者不必操作 IPC 或 Rust 內部 API。

`session.capabilities` 是唯讀的 Worker receipt snapshot（runtimeOpen/sendTurn/hostTools/cancelTurn/resumeSession/monitorMetadata），不將 compiled support 視為實機 Gate 證據。
