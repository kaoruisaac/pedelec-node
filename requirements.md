# Pedelec Node — Level 1 Agent Tool Trace 與獨立 Repo／單一 npm Module 需求

- **建立日期：** 2026-11-09（Asia/Taipei）
- **歸屬：** Pedelec Node 獨立子專案；Pathcraft Desktop 僅為現有程式碼來源及未來 Consumer
- **狀態：** Requirements Confirmed；MD01 已有未提交實作、Gate A 測試通過但真 Provider Gate 未完成；[MD01 Follow-up 01A](implementation/01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md) 已確認並 Ready for Coding；MD02 尚未開始
- **範圍權威：** 本文件定義本次新目標；既有 SDK Session／Host Tool／Storage 安全契約仍有效，若衝突以最新使用者決策為準
- **技術來源（2026-11-09 Mac mini 靜態盤點）：** `../pathcraft-desktop/packages/pedelec-node/`、`../pathcraft-desktop/rust/crates/`、`../pathcraft-desktop/server/monitor/`、`../pathcraft-desktop/scripts/build-server.mjs`、`../pathcraft-desktop/scripts/build-desktop.mjs`
- **相關研究：** `../graphroom/research/SOLVER_TOOL_TRACE_FEASIBILITY_AUDIT_2026-11-09.md`
- **2026-11-09 最新 Tool Trace 決議（覆蓋本文件中相反舊條文）：** [01A Event-first Follow-up](implementation/01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md) 為最新實作與驗收契約。SDK Trace **不再 Redact Secrets／Private Paths、保留 Truncation**；Trace-only 失敗不得中止 Provider Pump；改為 Event-first、**不維護完整 Tool Record 狀態機／不補造 finished/unknown**，只允許有界 Provider 協定 ID Cache。本文後續仍提及「安全摘要／Redaction／必須去重／合成 unknown」的文字視為原 MD01 歷史基線，與 01A 衝突時以 01A 為準；Consumer 仍負責外部資料安全及存取控制。
- **舊方向：** `../pedelec-memo/proposals/P-003-independent-pedelec-runtime-kit.md`；其中原先考慮「SDK 主 package＋平台 package」為候選，**已由本輪使用者的「單一 Repo、單一 npm Module」方向覆蓋**。過去延後抽離的時間規劃亦由本輪優先處理決策更新。

## 0. 決策狀態與本輪任務邊界

### 0.1 Confirmed User Intent

1. **本輪聚焦 Pathcraft Desktop 內的 Pedelec Node**，要求可完整支援 **Level 1：Agent 直接發起的 Tool Calls**，作為未來 GraphRoom Solver 實際執行證據。
2. **不要求擷取 Agent 私有 reasoning**；需要觀察真實工具使用（尤其是 Native Bash／Shell、其他 Agent 原生工具、`pedelec-cli` Host Tool）及成功／失敗等執行結果。
3. SDK 正式 Listener 名稱定為 **`session.onAgentToolEvent(listener)`**；唯讀觀測 Agent 真實 Tool Lifecycle，不取代 `onTool(name, handler)`。
4. **Pedelec Node 獨立成自己的 Git Repo，對消費者只是一個 npm Module**；SDK、Rust Worker、Runtime 等是同一產品交付單位。
5. 拆分兩份獨立實作文件：`implementation/01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md`，再 `implementation/02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md`。**文件完成不等於 Coding／驗收。**

### 0.2 已確認方向的工程落地原則（細節依 MD01/02）

- 正式採 `session.onAgentToolEvent(listener)`：語意專指 Agent Tool Execution Lifecycle，避免 `onAgentLog` 混入普通聊天、debug、stderr／reasoning，也避免既有 `session.onTool(name, handler)` **Host Tool Handler** 名稱混淆。
- SDK 提供同一種標準的、型別化 Tool Trace 事件；Rust Worker 內部以 Provider-specific Adapter 解析 Native Tool 事件，Host Tools 使用 SDK 現有的 handler／CLI 流程。
- Level 1 以 **Provider 暴露給外界的 Tool Invocation** 為觀測邊界：外層 Bash command 是一個 Tool Call；不攔截 Bash 裡面每個子程序。
- 首發正式支援平台為 macOS arm64、Windows x64、Linux x64（Linux 必含 Debian／Ubuntu glibc 與 Docker Consumer 測試）；其他平台需另行驗證。
- **單一 npm Module = `@kaoruisaac/pedelec-node`、一個版本、一個安裝入口**，包含三平台的原生 binary；不拆成平台專屬 npm packages。GitHub Repo 為 `kaoruisaac/pedelec-node`，Public 開源發行已核准，發行前仍須通過安全／品質 Gate。

### 0.3 非目標

- 不解析、不保存模型內部 reasoning、Chain-of-Thought、隱藏策略或 Provider 私有思考訊息。
- 不實作 Level 2/3：不追蹤 Shell 腳本內每一條指令、全部 fork/exec、網路請求、Browser 頁面上的每次 DOM click／CDP 操作或 OS syscall。
- 不因為 Trace 需求而把 `agent-browser`、Chrome for Testing、Tauri、Pathcraft Graph／Run／ACL／SQLite 放進 Pedelec Node npm package。
- 不由 SDK 判斷 Tool 對業務目標是否「有效／多餘」；該判斷屬於 GraphRoom Planner／Host。
- 不把 Monitor 的私有原始流直接視為永久業務證據庫。
- 已授權 MD02 經 Release Gate 後建立公開 GitHub Repo／npm publish、並在 Consumer Migration 驗證後刪除舊重複實作；**不授權**重寫既有 Git history、未經驗證直接清理舊 SDK 或擴大其他 Pathcraft 功能。

## 1. 現況證據與已知缺口（Source Audit，非 Provider E2E）

| 範圍 | 2026-11-09 原始碼觀察 | 新需求 |
| --- | --- | --- |
| SDK | `packages/pedelec-node/package.json`：`@pathcraft/pedelec-node@0.1.0`，`private: true`，npm workspace，exports 指向 `src/index.ts`；Node engines `>=24.22.1 <25` | 建立可從**獨立 Repo** build/pack/install 的一個正式 npm Module（JS＋Type declarations＋原生執行資產） |
| Host Tool | `src/session.ts` 已有 `tool.request`、`tool.handler-started`、`tool.handler-finished`、`tool.reply-acknowledged` 等；`pedelec-cli` 使用 SDK 私有 CLI endpoint | 需完整且可關聯地納入 Agent Tool Trace；保留原 Handler／ACK 語意 |
| Native Tools | Worker 的 Codex／Claude／ACP／Ollama／Antigravity Adapter 有 Protocol Traffic 入口，常規 SDK Event 並未形成通用 Native Tool Lifecycle | 提供各 Provider 原生 Tool 的統一事件 |
| 詳細 Monitor | Desktop `server/app/server.ts` 開啟 `detailedMonitoring`；Worker `PATHCRAFT_MONITOR_DETAILS` 可轉送有界 Provider payload | Tool Trace **不依賴 Desktop-only Debug 開關**；一般受信任 SDK Consumer 亦可觀測 |
| Monitor 保留 | `AgentMonitorService` 為 RAM-only；每 Session 預設 300 events、總 10,000 events／32 MiB，重啟丟失；事件含 redact／truncate | 不拿 Monitor 當唯一 Trace 證據來源；Host 有自己選擇的持久化責任 |
| Rust Assets | Cargo workspace 含 `pedelec-shared/core/runtime`、`pathcraft-ipc-worker`、`pedelec-agent`、`pedelec-cli`；Pathcraft Build Scripts 複製三個 binary | Runtime Kit 自己建置、版本化、分發三個執行檔；Host 不必 copy Cargo 原始碼 |
| 耦合 | `rust-ipc-supervisor.mjs` 依賴 `__PATHCRAFT_BUNDLE__`、`PATHCRAFT_RUST_WORKER_BIN`、`rust/target` 相對路徑；Pathcraft Server Build 內含 SDK source | Runtime 自我定位 package assets；Pathcraft Host 改用套件公共入口 |

> 以上為靜態查碼。尚未真實跑六 Provider 的工具事件比對；**不可把「協定提供通知」直接寫成「Tool Trace 已支援」**。

## 2. Level 1 定義與涵蓋率契約

### L1-001 — 必須觀測的行為

- 針對同一 `PedelecNodeSession` 內 **Agent 自身發起、Provider 明確有暴露事件的每次 Tool Invocation**，依序記錄其識別、開始／進度（若有）、結束及結果。
- 只要是 Provider Native Tool，均在範圍內，**不得只處理 Shell 一種**：例如 Shell/Bash、讀寫檔案、Search、Provider 原生 Browser/MCP/其他工具（以 Provider 真正暴露的 Tool Event 為準）。
- Shell 呼叫須保留足以辨識命令的**安全摘要**、工作階段、完成狀態，以及 Provider 若有提供的退出碼／錯誤類別／輸出摘要。
- `pedelec-cli tool-spec`、`pedelec-cli tool-call` 若經原生 Shell 發起，其外層 Native Shell Invocation 仍在 Level 1；`tool-call` 造成的 Host Handler Invocation 須另有內層 Host Tool 觀測，**要能做關聯、不得默默將兩次觀測視為兩次不同的業務步驟**。
- Tool 被拒絕、輸入不合法、逾時、取消、Provider 中斷、結果未知，也都須以實際已知事實表示；**不能只記成功的 Tool Calls**。

### L1-002 — Level 1 明確不包含

例：Agent 送出 `bash -lc './fetch-and-parse.sh'`，Level 1 至少記錄這個 Bash Tool Invocation 及觀測到的結果；**不保證**看到腳本內個別 `curl`／`python`、每次檔案操作／網路請求。Agent 透過 Shell 執行 `agent-browser click ...` 時，Level 1 記錄**該 CLI 命令呼叫**及結果；不將工具內部的所有瀏覽器互動假裝成可觀察的獨立 Tool Call。

### L1-003 — 「完整」與 Coverage

- 「完整 Level 1」定義為：**對宣稱支援的 Provider／版本／平台，能針對已知 Provider 對外暴露的每次 Tool Invocation 建立可靠 Lifecycle 記錄，並明確標示任何缺少／不確定的欄位或事件**。
- SDK 不得用 Chat Transcript 推測工具發生過，也不得為缺失事件杜撰 exit code、args、成功結果。
- 明確區分 `supported`、`partial`、`unsupported`、`unknown` 的 Provider/Session 覆蓋狀態，以及每個 Tool Record 的 `unknown` 結局；不可用「Provider 支援」隱藏實際觀測不足。
- 若目標 Provider 在可執行 Tool 時**不會回報必要 Tool Call Event**，該 Provider 的 Level 1 驗收即 **BLOCKED**；不得為了通過驗收而把「無事件」解釋成「沒呼叫工具」。不因此一律阻止正常 Agent Session 使用，是否允許該 Provider 作為嚴格 Solver 另由 Host 決策。
- 服務崩潰、IPC 遺失、事件裁剪或監聽端處理不及時，須有可辨識的 gap／truncated／coverage 降級證據；無法觀測並不等於零操作。

### L1-004 — 技術成功不等於 SOP 有效

SDK 只報告 Provider/工具層可確認的狀態（如 `completed`、`failed`、`cancelled`、`unknown`，及成功／退出碼）。**「這次 Tool 對目標有效」、「可以合併進某個 Graph Node」、「多餘」**都由 Host／Planner 依任務成果判定，不加入 SDK Event 語意。


## 3. SDK 新 Listener 與資料契約

### L1-API-001 — 對外 API

**正式核定名稱：**

```ts
const session = await runtime.createSession(config);

const unsubscribe = session.onAgentToolEvent((event) => {
  // 唯讀的 Agent Tool 行為事件；Host 自行儲存、查詢與分析。
});

// 既有 session.onTool(name, handler) 照常處理 Host Tool。
// 兩者完全不同：onTool 是執行 Handler；onAgentToolEvent 是觀測事實。
```

- **Must：** SDK 公開、跨 Provider 的型別化 `session.onAgentToolEvent(listener): Unsubscribe`；原有 `onTool`、`onChat`、`onChatDelta`、`onStatus`、`onError`、`onTurnEnded`、`onMonitorEvent` 不改舊意義。
- **Must：** 註冊／解除訂閱可多次使用；無 listener 也不阻擋 Agent；listener throw/reject 不得干擾 Tool、Turn、ACK、Provider／Worker 生命周期。
- **Must：** Listener 不得取得 Rust Transport、內部 session handle 或改寫事件；事件只讀並有穩定的 public `TypeScript` 型別。
- **Should：** 如未來跨 Session 聚合有需求，可另外設 `runtime.onAgentToolEvent` 唯讀觀測入口；**本次先要求 Session-level，不預先擴張為泛用 Log API**。
- **No：** 不以 `onAgentLog` 混用包含 Chat、Reasoning、Stderr、Internal Debug 與 Tool Lifecycle 的自由字串訊息。

### L1-API-002 — 標準事件（建議 DTO，非最終 Schema）

```ts
type AgentToolEvent = Readonly<{
  sessionId: string;
  turnId: string | null;
  provider: PedelecProvider;

  source: 'provider-native' | 'pedelec-host';
  kind: 'started' | 'updated' | 'finished' | 'observation-gap';
  toolCallId: string;         // SDK 可識別同一呼叫的穩定 ID
  nativeToolCallId?: string;  // Provider 真實 ID（若有）
  parentToolCallId?: string;  // 例如外層 Bash 呼叫 pedelec-cli
  toolName: string;           // Provider 原名，或真實 Host Tool 名
  toolKind: 'shell' | 'file' | 'browser' | 'search' | 'mcp'
    | 'host' | 'other' | 'unknown';

  at: string;
  status?: 'running' | 'completed' | 'failed'
    | 'denied' | 'cancelled' | 'unknown';
  exitCode?: number | null;   // 只填 Provider 明確回報的值
  input?: unknown;            // 經安全規範處理的結構化摘要
  output?: unknown;           // 經安全規範處理的結果摘要
  errorCode?: string;
  coverage?: 'supported' | 'partial' | 'unsupported' | 'unknown';
  detailTruncated?: boolean;
}>;
```

- DTO 必須保留 `provider`、`sessionId`、`turnId`、原生 Tool ID（如有）、SDK 正規化 ID、觀測來源、可得的時間、狀態與結果，供 Host 還原調用次序。
- `toolName` 保留實際名稱（不是只剩 `shell` 類別），`toolKind` 提供方便顯示的分類；未知 Tool 不得丟棄。
- Provider 缺少 `turnId` 或 native call ID 時應明示缺口，必要時使用 SDK-generated ID 但不得假裝它是 Provider 原始 ID。
- 對同一 Tool 允許 `started → updated* → finished`；若只有 `finished` 也要留下紀錄，不能因缺 `started` 就丟棄。若只看到 `started` 而沒有最終結果，顯示 `unknown` 或 gap，不能自動補 completed。
- 對同 Session、同 Tool 的重複 Protocol Notification 應去重／更新而非新增一筆；不同 Turn、不同 Session 的 Tool ID 不可錯誤合併。
- `source: 'provider-native'` 和 `source: 'pedelec-host'` **都要保留**；當一次 Bash 呼叫 `pedelec-cli tool-call` 觸發 Host Tool，應保留父子關聯與各自 outcome，不以去重造成資料遺失。
- 在可以安全取得時保留 **Shell command、工作目錄提示、被呼叫工具與重要參數、stdout/stderr 摘要、exit status**；沒有欄位就明示 unavailable。被遮蔽／截斷的值要可辨識，不能偽裝成完整原文。
- Provider 對單次 Tool 結果可能只回報整體 Task/Turn 成敗。不得把 Turn Terminal 狀態誤灌給其內每個 Tool。

### L1-API-003 — Observability 不影響執行

- Native Tool Trace 是**旁路觀測事件**，不透過 SDK Host `onTool()` 假冒工具回呼；不要求 Agent 一律改用 `pedelec-cli` 才能被追蹤。
- Provider Trace Adapter 失敗時不得無理由中止原本可正常執行的 Agent；錯誤／覆蓋缺口必須可觀察。由 Host 決定是否因證據不足拒絕「Solver completed with full trace」。
- Tool Trace 不能打亂現有 provider event sequencing、`onTurnEnded` 語義與不可重試規則；事件不可靠時不憑觀測假設 Tool effect 不存在。
- SDK 應將 Trace 的來源與可信度講清楚；無法取得 stdout、exit code、原始參數時允許結果未知，但不得對使用者聲稱完整細節可用。
- 事件即時流須有**有界資源**與顯式缺口訊號；實作必須測試高頻工具事件、slow listener、重入、同步 throw／非同步 reject、取消／Worker crash。
- **SDK 不保證 Host 永久保存事件**：同機 crash 前尚未交給 Host／Host 尚未持久化的 Event 可能遺失；除非後續另立 durable transport 契約，不得宣稱 crash-proof／exactly-once trace。

## 4. Provider Native Tool 事件來源與覆蓋矩陣

| Provider | 已存在的入口（原始碼） | 必須驗證與補齊 |
| --- | --- | --- |
| **Codex** | App Server `item/started`、`item/completed` 等 RPC；目前通常作 `provider.rpc` 而不是 Tool DTO | `commandExecution`／其他 Tool item 的名稱、command、狀態、exit code、ID、不同 Tool type；進度與完成關聯 |
| **Claude** | `ClaudeStreamController` 接收 Stream JSON；含 `assistant` 的 Tool-use 與 `user` 的 Tool-result 類資料 | Bash／檔案工具執行、`tool_use_id` 配對、失敗／中斷、stdout／exit 等 Provider 真實提供的資訊 |
| **OpenCode** | ACP `session/update` 的 `tool_call`、`tool_call_update`；Runtime 可見原生通知 | tool-call ID、kind、status、`rawInput`／`rawOutput`（如有）、完整與缺失的 update |
| **Cursor** | 同 ACP transport，但 Provider 事件形狀可能不同 | 獨立 fixtures 與實機驗收；不可用 OpenCode PASS 直接推論 Cursor PASS |
| **Ollama / pedelec-agent** | 自有協定 `turn/tool_call`、`turn/tool_result`；內部 `AgentTurnSink` 已生成此類事件 | Worker/SDK 正規化 restricted Bash、檔案、Search 等工具；回覆／錯誤與同一 ID 配對 |
| **Antigravity** | Stream `step_update`、`result` 與部份 Hook；可觀察性與其它 Provider 不等價 | 先做能力探勘；若其協定無完整 Tool Calls，必須標示 `partial/unsupported`，直到有可驗證解法，不得虛報 Level 1 FULL |

**Coverage Gate：** Codex、Claude、OpenCode、Cursor、Antigravity 納入本次 Provider Adapter／逐一驗證；受 Provider 協定限制者可標 BLOCKED 並公開真實 Coverage，不要求六個全部 PASS 才完成本次範圍。**Ollama 的 `pedelec-agent` 修改延至獨立 Backlog**；本次不修改其實作，也不可宣稱 Ollama Level 1 FULL。所有 Provider 必須明列 PASS／FAIL／BLOCKED／NOT RUN。

## 5. 新 Repo 與單一 npm Module

### PKG-001 — 產品與原始碼邊界

- Git 應有**一個新、獨立的 Pedelec Node Repo**，內含 Node/TypeScript SDK、SDK 私有 transport、Rust IPC Worker、所需 Rust Runtime/Core/Shared crates、`pedelec-agent`、`pedelec-cli`、Build/QA/Release scripts、docs 與 License/Notices。
- **Git Repo 數量 1、npm Module 數量 1**；Cargo workspace 可包含多個 Rust crates，native bundle 可包含數個 binary，但它們不是要使用者額外安裝的 npm modules。
- 新 GitHub Repo 固定為公開 `kaoruisaac/pedelec-node`，與 Browser Extension／Desktop bridge 為主的 `kaoruisaac/pedelec` **完全獨立**；使用全新 Git History，不合併既有 Repo。
- 新 Repo 不依賴 Pathcraft 的 TS Server、SQLite、UI、Graph、Run Driver、Tauri、Desktop Asset Pipeline。所有 Host 業務行為、ACL、Graph Planner、持久化 Trace 保留在各 Consumer。
- Rust Worker、SDK 內部不應硬編碼 `PATHCRAFT_*` 命名、Pathcraft 專屬 Host Tool／Role／Scope 或 Pathcraft 專屬檔案佈局；所有正常 Runtime 技術資料仍由 SDK 在獲授權的 `runtimeStorageRoot` 下管理。

### PKG-002 — 安裝與 API 使用體驗

- 一個 `npm install @kaoruisaac/pedelec-node` 即安裝 SDK **及該支援平台所需全部 native 執行資產**；Consumer 不需手動 copy Rust 原始碼、跑 Cargo、另外安裝 `pedelec-cli` 或設定 `PATHCRAFT_RUST_WORKER_BIN`。
- SDK 公開一個正式 JS entry point（`exports`）與 TypeScript declarations，Node ESM 可直接載入；既有 `createPedelecRuntime`、`createSession`、`resumeSession`、`sendText`、`onTool`、`onChat`、`onArtifact`、`cancel`、`close` 等高階契約維持。
- Rust Worker、`pedelec-agent`、`pedelec-cli` **仍由 SDK 自動定位／啟動與管理**。Provider CLI 與帳號認證仍為外部依賴；不可暗示 npm package 內含 Codex/Claude/OpenCode/Cursor/Antigravity 或所有模型。
- 安裝者通常**不需啟動 Rust Server、暴露 IPC 通訊埠或持有 Binary Path**。必要部署級 override 只限受信任 Host，不是 Model 可以任意傳入的 Tool argument。
- 不透過消費者的 `node_modules` 非公開深層路徑作正式 API；SDK 私有 RustIPC/NDJSON/Tool ACK 層對外不承諾長期相容。

### PKG-003 — 單一 Module 的 Native Binary 發行政策

- 由於**不拆平台專屬 npm modules**，建議初版同一 npm artifact 內包含宣稱支援平台的 Worker／Agent／CLI binaries，例如 `bin/darwin-arm64/`、`bin/win32-x64/`；Runtime 只選取符合 `process.platform/arch` 的資產。
- 不要求為尚未支援的 OS/arch 夾帶檔案；不應在安裝期從未驗證的 URL 下載任意 binary，亦不可在最終使用者電腦默默編譯 Cargo。若改採 postinstall 發行策略，屬 **需使用者明確重新決策** 的 package 方案變更。
- 單一版本的 JS SDK 與三個原生 binary 必須匹配，提供 binary manifest（平台、版本、SHA-256、可執行檔與封裝資訊）及啟動前／啟動時 compatibility check；不符要**明確失敗、不得 fallback 到工作樹 `rust/target` 的舊 binary**。
- 發布的 `npm pack` 內容要完整可審查，正確包含 JS、`.d.ts`、資產／checksum／License／第三方 notices；不包含密鑰、Provider Auth、private Workspace、test logs 或平台無關的 build cache。
- 需檢查 macOS、Windows 的 executable permissions、路徑有空格、native Process Tree 收斂、Code Signing／Notarization 適用條件，以及可合法再散布的 dependencies。**Pathcraft MD26 的 Chrome for Testing 授權問題不轉嫁到此套件**（Chrome/agent-browser 不在本 Kit）。
- 原始 Repo 可在 CI 分平台建置、再組成**同一 npm package**；不要求每個開發者本機同時具備 macOS／Windows 編譯環境。
- 新 Repo、package name、npm scope 與公開發行已由使用者核准；發行前需確認 npm scope 權限、CI secret、License／第三方 notices、簽章條件與三平台驗收。文件階段尚不建 GitHub Remote、不執行 npm publish。

### PKG-004 — Pathcraft Desktop 改作正式 Consumer

- Pathcraft Desktop 由 npm dependency 使用新套件；原 `@pathcraft/pedelec-node` private workspace import、`src/index.ts` 直接 import、`rust/target` 假設、`build:rust`／`build:server`／`build:desktop` 的 SDK 自行打包與 binary copy 策略須調整。
- **Pathcraft Desktop 仍擁有其 `server/app`、Session Port、Tool Manifest、Owner/ACL、Monitor UI、Graph、Run 與資料儲存，不能藉抽離把 Host business code 放進 SDK**。
- Desktop/Hosted 發行資產仍需包含 Runtime Kit 所需 executable；但來源改為已安裝且版本匹配的 npm Module，而不是另一份混在 Pathcraft Rust workspace 裡的 build 產物。
- 新 Repo 的 `npm pack` 必須能在 **完全沒有 Pathcraft Desktop 原始碼** 的乾淨 Consumer Project（含 Linux Docker）安裝與使用；Pathcraft Desktop 必須反過來作為下游 consumer 完成回歸驗證。
- 搬移時保留既有 API 行為與安全規範；若新名稱使 Consumer import 路徑改變，以明確 Migration Guide 與一次性修改 Consumer 完成，**不保留永遠維護的兩份 SDK 實作**。
- 遷移前先核對 Git worktree，保留目前 MD26／MD27 等其他人可能正在進行的未提交變更；不可 `reset --hard`／`git clean` 或直接刪 SDK 原址。
- 同步測試 Server Bundle（目前 esbuild 會整合 SDK 原碼）、Tauri/Bun Runtime 以及 Windows Native Provider Spawn；不因套件抽離默默改變執行主體權限。

## 6. 安全、生命週期與相容規範

### SAFE-001 — Tool Trace 敏感資訊

- Native Tool Input/Output 可能含 API key、Auth header、cookie、private path、stdout secrets、完整檔案內容；**即使本機 Desktop 也不得預設將全量 Raw Protocol Traffic 原樣當作 Agent Trace API 或持久化證據**。
- 建議分層：**public event** 給足工具名、命令／參數安全摘要、結果、錯誤及可回溯 ID；原始 Provider 訊框仍由受信任的 Debug 模式處理並遵循保留／redaction 規範。
- 若因 Planner 蒸餾 SOP 需要足量 command detail，應保留**已遮蔽敏感參數的可用命令**，對缺少／隱藏／截斷的欄位附 `redacted`／`truncated` 證據。禁止只留下 `tool=Shell` 卻聲稱完整可分析。
- 新 Repo 不自行管理 Host 的 Task/Workspace/Owner；Host 在 persistence 和 UI 暴露 Trace 時仍需執行身份驗證、授權、保留期與刪除政策。
- 只允許 Agent 執行現有 Provider／Host 已允許的 Tool；Trace 不授予新 OS 權限，也不是 Sandbox。

### SAFE-002 — SDK 行為不回退

- 不更動 `pedelec-cli` 為 Host Tool 唯一正式 Transport 的既有決議；所有 Provider Host Tools 仍以 CLI 進入 SDK Host Handler。
- 維持 SDK 的 `scope/role/metadata` 移除與 ID-only `resumeSession(sessionId)`；不可重新引入 SDK 私有 Session JSON 或跨 Runtime 重啟自動接回。
- 維持最近 50 個 ended RAM Handle、`runtimeStorageRoot` 隔離及 SDK Session-scoped Artifact/Provider State GC（目前 MD25 契約）；不因導入 Trace 把資料改回 Pathcraft 業務目錄。
- 維持取消、close、Timeout、Worker crash、晚到 Event／Tool ACK 的 fail-closed、outcome-unknown、no-retry 規範；**Tool Trace 不可造成 Tool 重播或二次副作用**。
- 現有 `onArtifact`、`onChatDelta`、`onTurnEnded`、Monitor、真 Provider Session、CLI Host Tool、Provider Resume 等需跑回歸；Trace Listener 的資料不得改變這些 callback 的順序或責任。

## 7. 驗收要求（可作後續拆 MD 的 Release Gates）

### Gate A — SDK Tool Trace 合約

- [ ] MD01：TypeScript public API 從當前 SDK entry import，`session.onAgentToolEvent()` 可解除訂閱；**獨立 npm package import 由 MD02 Gate C 驗證**。
- [ ] Fake Provider 事件測試覆蓋每次 Call 的 started/updated/finished、failure/denied/cancelled/unknown、重複事件去重、無 started 的 finished、late event、跨 Session 並行／Turn ID 關聯。
- [ ] 現有 `onTool()` Host Handler 可與新 Listener 同時工作；`pedelec-cli tool-call` 的外層 Shell 與內層 Host Tool 能保留 provenance、相關 ID 與不重複計數策略。
- [ ] 不註冊 Listener 與 Listener throw/reject/slow/解除訂閱都不改 Provider／Tool 執行結果。
- [ ] 使用者不需開啟 Pathcraft Monitor 或 `PATHCRAFT_MONITOR_DETAILS=1` 才能收到 Tool Trace；`onMonitorEvent` 仍正常。
- [ ] 涉及秘密、路徑、工具輸出大量文字的負向測試證明安全遮蔽、上下限與可辨識截斷，不洩漏 auth。
- [ ] Runtime 遭 crash／網路或 IPC 異常，事件缺失以 gap／unknown 呈現，不補假成功，不觸發 retry。

### Gate B — Provider Level 1 真實驗收

以**同一組 Scenario** 在本次執行的 Provider（Codex、Claude、OpenCode、Cursor、Antigravity）真執行；Ollama／pedelec-agent 修改已明確列 Backlog，僅留能力／Coverage 紀錄，不將其作為 MD01 的強制 Coding Gate：

1. Native Shell：成功（`exit 0`）、失敗（非零 exit）、可取得的 stdout／stderr、command／ID 比對。
2. Native 非 Shell Tool：例如讀檔、檔案修改、Search 等該 Provider 支援的真工具；核對 Tool 名稱、參數與結果。
3. `pedelec-cli tool-spec` → `tool-call` → SDK `onTool`：成功與 Handler 失敗，以及 Native/Host 關聯。
4. `agent-browser` CLI 透過 Agent Shell 呼叫：驗收的重點是 **Shell Invocation** 是否可被記錄，不要求 browser click 子步驟。
5. 多個 Tool 連續呼叫、同時不同 Session、Cancel、Provider crash、unknown outcome。
6. 若 Provider 回報的某個欄位原本就不可得，要清楚顯示 `unavailable` 並附協定證據；若連工具呼叫都無法辨識，該 Provider **不得 PASS** 完整 L1。

每一 Provider 與 OS 組合記錄 **PASS／FAIL／BLOCKED／NOT RUN**，包含真 Provider 版本、原始事件證據（安全遮蔽）、SDK Trace JSON、期望／觀測差異；Unit Test PASS 不能替代真人 Provider E2E。

### Gate C — 獨立 npm Module 與新 Repo

- [ ] 獨立 Git Repo 可在不引用 Pathcraft Desktop 路徑下完成 `npm ci`、typecheck、TS build、Rust build、unit/integration tests、`npm pack`。
- [ ] `npm pack` 只有**一個 npm package**；Artifact 裡包含必要 JS、`.d.ts`、manifest 與指定 OS/arch 的三個 executable（Worker、Agent、CLI），不存在平台專屬 npm package 依賴。
- [ ] 在乾淨、非 monorepo Node Consumer 安裝 tarball：正常 import → createSession → Agent native trace → CLI Host Tool → onTool → cancel/close → process cleanup；不能需要 Pathcraft Repo 的原始檔／Cargo。
- [ ] SDK／Binary 版本錯配、未知 OS/arch、缺少 Binary、缺少 Provider 執行檔均有明確、可讀、非洩密錯誤；不得意外執行來源樹的舊 Binary。
- [ ] Package 一致性清單、Checksum／Reproducible Build、License／Third-party notices、Native Process Cleanup 驗收通過。
- [ ] Pathcraft Desktop 改正式依賴新 package，`npm run typecheck`、`test:sdk`（或新 package 等價命令）、`build:server`、`tauri dev/build` 與實際 Provider/Host Tool／Session Monitor 回歸通過。
- [ ] **沒有外部獨立 Consumer PASS，不得聲稱獨立完成**；沒有 Windows 真機與 Linux glibc Docker Consumer 證據，不得聲稱 Win x64／Linux x64 首發支援完成。

## 8. 平台與測試矩陣（已核定首發目標，不代表 QA 已執行）

| 項目 | macOS arm64 | Windows x64 | Linux x64（glibc／Docker） |
| --- | --- | --- | --- |
| Build 與單一 npm Package 原生資產 | 必須 | 必須 | 必須 |
| 乾淨 Consumer npm install／native spawn | 真機／CI | Windows 真機／CI | Linux CI＋Debian/Ubuntu Docker Smoke |
| Native Tool Trace | Codex／Claude／OpenCode／Cursor／Antigravity 按可用性逐個驗證，無證據即標記 | 同左 | Linux 可用 Provider 逐一驗證，未具帳號／CLI 明標 NOT RUN |
| Tool Handler／Cancel／Resume／Crash／Cleanup | 必須 | 必須 | 必須含 container SIGTERM／non-root |
| Pathcraft Desktop / Hosted 回歸 | Desktop | Desktop | Server／Docker consumer；不得默認 Tauri Linux Desktop |

**首發 Linux 邊界：** 提供 glibc x64 native binary，至少驗證 Debian/Ubuntu-based Node Container；Alpine/musl 不屬本次已核定平台，不得默認可用。若需要 Alpine 應另列 Backlog。Ollama `pedelec-agent` 改動本次 Backlog，所有平台不得標示其 Tool Trace FULL。

> 這張表是**需求中的驗收目標**，不是本次完成結果。各 Provider 真實可用性可能受安裝、登入、模型及 OS 限制，不能以自動化 mock 替代全部真實驗收。

## 9. 已確認決策（2026-11-09）與少量剩餘 TBD

| 決策 | 使用者核定 |
| --- | --- |
| Q1 API | `session.onAgentToolEvent(listener)`；既有 `onTool(name, handler)` 不變 |
| Q2 第一階段接線 | 第一份僅 SDK／Rust／Provider 與獨立驗證，不整合 Pathcraft Monitor |
| Q3 資料詳度 | B：保留能安全取得的 command、args、stdout/stderr、exit code 與 redaction／truncation 證據 |
| Q4 Provider | B：逐一驗證、有協定限制可 BLOCKED；**Ollama 修改 `pedelec-agent` 列 Backlog** |
| Q5 發布 | A：**公開** `kaoruisaac/pedelec-node` GitHub Repo 與 `@kaoruisaac/pedelec-node` npm；仍須發布前 Gate |
| Q6 平台 | B：macOS arm64、Windows x64、Linux x64（server／Docker 是正式需求） |
| Q7 Git | A：全新 Git History、獨立 Docs Assistant 子專案 `pedelec-node/`；與 Pathcraft Desktop 分開 |
| Q8 遷移 | A：Consumer 驗證後移除 Pathcraft 內舊 SDK 與重複原生實作，不留雙份 |

**工程細節（按最保守值執行，非要求再開 User 討論）：** 截斷預設上限及欄位級 redaction 由第一份 MD 鎖定並測試；SemVer、SBOM／License、manifest、npm release secrets、Linux glibc baseline 與可重現性由第二份 MD 訂規範。公開發行已授權，但仍以 Build、三平台 Consumer QA、法務／Secrets Gate 通過為實際 publish 先決條件。

## 10. 實作文件與交付邊界

1. [01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md](implementation/01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md)：只修改目前 Pathcraft 工作樹中的 SDK／Rust Worker／Provider trace 接線，先驗證 API 與 Provider Coverage；**不在這份搬移 Repo 或修改 Pathcraft Host／Monitor**。
2. [02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md](implementation/02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md)：新 Repo、TS／Rust build、三平台單一 npm package、公眾發布、Pathcraft Desktop Consumer 替換與回歸；依賴第一份結果。
3. [BACKLOG.md](BACKLOG.md)：Ollama／`pedelec-agent` Tool Trace 補強、Linux musl、額外平台和非本次範圍。

**文件階段：** 本輪只建立與整理 Docs Assistant 文件和獨立子專案，不修改 SDK／Rust／Pathcraft Runtime，不建立 GitHub Remote、不執行 npm publish。程式、Provider E2E、正式公開仍待 Coding Agent 依兩份 MD 實施與留下證據。
