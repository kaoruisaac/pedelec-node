# Pedelec Runtime Kit — 移植與維護手冊

> **2026-11-05 MD19 現況（覆蓋下方與此不符的描述）：** 六個 Provider 的 Host Tool 全走 `pedelec-cli`，`hostTools` 表示 CLI 回路已在程式接好，不代表真 Provider 已驗收；Worker 的 `tool-reply` 回 `UNSUPPORTED_IN_CLI_MODE`，MCP Bridge 已刪。Provider Artifact 由 SDK 在 `runtimeStorageRoot` 下落地，`onArtifact` 在驗證與原子 rename 完成後通知。原始 `artifact.path` 是短期絕對路徑，需長期保存時由 Host 複製到業務目錄。 傳送失敗回 `ARTIFACT_STORAGE_FAILED`，不影響 Turn。輸入附件無上游路徑，`sendText` 收到 `attachments` 會拒絕。全部 IMPLEMENTED / UNVERIFIED，見 `implementation/Archived/provider-sdk-completion/19_PROVIDER_CLI_TOOL_SDK_COMPLETION.md` §10。
>
> **2026-11-05 CLI transport 優先更新：** Host tools 唯一正式入口為 Provider shell 的 `pedelec-cli --thread-id <SDK sessionId> tool-spec NAME` / `tool-call NAME '<json_args>'`。SDK `createSession({tools, hostInstructions})` / `onTool` 不變；SDK 為每個 create/attach 建立私有 loopback NDJSON endpoint，Worker 子程序繼承 runtime file 與可信 binary PATH。Codex 不再註冊 Dynamic Tool，也不接受 native Tool reply。下文舊 native Tool / MCP / ACK 驗收描述屬歷史，不構成 CLI Gate B 證據。
>
> Schema 由 SDK Ajv 驗證（未知 keyword / remote ref 拒絕；缺省 `additionalProperties` 正規化為 false），Spec 保留 `argsSchema` 並提供 `schema` / `readSpecCommand` / `callCommand`。JSON args 限 64 KiB，結果限 64 KiB；同一 Turn 可串行多工具，同時 pending 拒絕，同 request ID 只回放相同 identity 的結果。Handler 的 `{success:false,result}` 會成為 CLI `{ok:false,result,error}`，輸送失敗與 outcome-unknown 不重試；`context.assertActive()` 仍是每次業務 effect 前必要檢查。
>
> `npm run build:rust` 現在包含實際 `pedelec-cli`；dev CLI 必須與 Worker 同目錄，打包放 `dist-server/assets/bin`。**MD17 已移除 CLI Session Token 與 Windows ACL 啟動阻擋**；各 OS 共用無 Token NDJSON Request，`generation` 僅為 Turn freshness。runtime file 與 `127.0.0.1` endpoint 採 Trusted-Local 模型，**無法阻止同機其他程序讀檔後嘗試呼叫 Host Tool**；Unix 0600/0700 僅為 best-effort 衛生，不是必要 gate。2026-11-05 Mac Codex 先前已有 CLI E2E 證據，但 **MD17 新版與 Windows/其他 Provider 未執行真 E2E（NOT RUN）**，不代表 Gate B/Release QA 完成。 詳見 `implementation/Archived/reports/16-pedelec-cli-tool-transport.md`，不可將以下範例視為已通過 E2E。

> 2026-11-04，**架構定位 Confirmed（產品方向）／獨立移植方案 Proposed（未實作）**。
> 對象：維護 SDK / Rust / Build / 發行的工程師。**一般 SDK 開發者只需閱讀 [開發者指南](DEVELOPER_GUIDE.md)**。
> 現況是 Pathcraft Desktop repo 內可運作的組合，**不是已發行的獨立 SDK**。

## 一、產品邊界：三層視為同一套可移植 Runtime

~~~text
Other Project (HTTP, CLI, Desktop, Backend, Test Harness)
  └─ Public: @pathcraft/pedelec-node
       ├─ PedelecNodeClient (runtime/session ownership)
       ├─ PedelecNodeSession (turn/tool/events/state)
       └─ private Rust IPC transport
            └─ pathcraft-ipc-worker (per Session child process)
                 └─ pedelec-runtime / pedelec-core / pedelec-shared
                      └─ Codex App Server
~~~

「Pathcraft IPC Worker + Rust Runtime + Node SDK」是**一個產品交付單位**：只暴露 Node SDK 的使用契約；Worker/IPC 是實作細節；Rust Runtime 是內部引擎。未來其他 Node 專案引用 SDK，應**不必**複製 Pathcraft Server、DB、Workspace、UI、Graph 或 Tauri。Tauri launcher 是 Pathcraft Desktop 的**宿主選項**，不是所有 SDK consumer 的必要依賴。

**核心穩定邊界**：外部只能依賴 `createPedelecRuntime / createSession / resumeSession(sessionId) / sendText / onTool / onChat / onStatus / onTurnEnded / cancel / close`；不得把 `RustIpcSupervisor`、`op`、`requestId`、`NDJSON`、`PedelecTransportConnection` 當作長期公開產品 API。現有 package 暫時 export 測試用 Transport seam，並不等於保證其語意穩定。

## 二、現有原碼責任與實際依賴

| 層 | 目前檔案／crate | 職責與可否移植 |
| --- | --- | --- |
| 公開 SDK | `packages/pedelec-node/src/{index,client,session,types,tools,events,errors}.ts` | Session API、事件、回呼、timeout/unknown、Tool reply；**可抽離的核心**。 |
| 私有 Transport | `packages/pedelec-node/src/transport/{rust-ipc.ts,rust-ipc-supervisor.mjs}` | binary resolution、spawn、stdio NDJSON、reply matching、event order、kill/cleanup；由 SDK 擁有。 |
| Rust IPC Worker | `rust/crates/pathcraft-ipc-worker/src/{main,protocol}.rs` | IPC v1 操作、Session/EventSink、Provider 事件橋接。名稱與協定仍有 Pathcraft 耦合。 |
| Rust Runtime | `rust/crates/pedelec-runtime` | Provider Controller、持續執行、Tool/Provider 交握；需搭配 `pedelec-core`、`pedelec-shared` 與 Cargo 相依圖完整搬移。 |
| Server adapter（非 Kit） | `server/agent/session/{index,execution-agent-session-port}.ts` | Pathcraft 專用 Owner ACL、Conversation/Run Binding、Task root、DB Commit、Graph Tool 規則，**不搬入 SDK**。 |
| Desktop Launcher（非 Kit） | `desktop/src-tauri/src/main.rs`、`scripts/tauri.mjs` | App 啟停、打包、Native Capability、Windows Job Object；別的產品可有自己的啟動器。 |
| Server startup（非 Kit） | `server/app/server.ts` | 一個共用 sdk client 注入 Planner/ToolDev/Execution adapters；可作整合參考。 |

### 目前 transport 實情

- `RustIpcSupervisor` 以**每個 Session 一個 Worker**的方式啟動，Worker 再連 Provider；stdio request/reply/event 為 Rust IPC v1。**不能假設多 Session 共用一個 Worker**。
- `src/client.ts` 接受六種已接線的 Provider，不接受 Host `scope`／`role` 或模糊 metadata；工具數量 **0～64**，由可信 Host 提供。SDK 私有 `src/session-state.ts` 可選擇在受控目錄持久化技術 Session 記錄，`resumeSession(id)` 僅按 ID 復原確認 idle 的原 Provider Thread。
- 已具備 Session lifecycle、不可逆 fault latch 與防晚到 Tool/ACK 的本地負向測試（M0 Coding PASS）；**09 獨立 QA 仍是抽離／發布 Gate**，不能單靠本地正向測試宣告已驗收。
- SDK 不持有 Pathcraft Run 或 DB，因此 **Run 不恢復、Tool Transaction、first-commit-wins** 屬於宿主產品的業務規則；不可透過新增 SDK retry 偷改語意。

## 三、現行宿主如何啟動與交付（非通用安裝方法）

| 場景 | 現行實作 |
| --- | --- |
| 開發模式 | `cargo build -p pathcraft-ipc-worker --manifest-path rust/Cargo.toml` 產 debug、`npm run build:rust` 產 release Worker；`rustIpc.binaryPath` 或 `PATHCRAFT_RUST_WORKER_BIN` 可覆寫。Rust transport 默認取 `rust/target/debug/pathcraft-ipc-worker`，`NODE_ENV=production` 則取 release。 |
| Server bundle | `npm run build:server` 透過 esbuild 整合 TS SDK，且打包腳本會規劃 Runtime binary；**bundled binary path 是 Pathcraft 定製**。 |
| Desktop app | `npm run tauri dev / npm run tauri build` 由 Pathcraft 專屬腳本準備 Node、CLI、Server、UI、Worker 與 native launcher；不代表 Kit 有獨立 installer。 |
| OS | 在每個 target OS/arch **各自建置、測試、打包** Worker，不可移用 macOS binary 至 Windows，反之亦然。 |
| Runtime config | `createPedelecRuntime({ rustIpc: { binaryPath, cwd, env, startTimeoutMs } })`；皆是維護/部署層組態。**不要讓 HTTP client 設定 Worker path 或 env**。 |

## 四、要做到「只懂 SDK 就能移植」還差哪些工作

這是**後續實作 Backlog / Proposed，非本次已完成的 API**。依優先順序：

1. **P0 fail-closed**：依 `implementation/Archived/11_SESSION_EVENT_MONITOR_PROPOSAL.md` M0 先修 P0-01 crash/sequence reversal 後 late Tool+ACK、P0-02 late completed 恢復 idle；做故障 latch / negative tests / 09 獨立 QA。
2. **名稱與型別脫鉤**：Package 名目前為 `@pathcraft/pedelec-node`，Worker 為 `pathcraft-ipc-worker`，環境變數為 `PATHCRAFT_RUST_WORKER_BIN`；擬定獨立命名、Version Strategy 及相容期，**不要直接改名破壞既有 import/bundle**。
3. **通用 Session Context（MD20 已落碼）：** SDK 與 Rust IPC 不認識 Pathcraft `scope`／`role`，不以任意 metadata 替換。Host 透過自己的 owner/role/Workspace/Task binding 授權和填充監控標籤；原 SDK Session ID 與 Provider 身分由 SDK 私有技術狀態管理。跨程序真 Provider 與 Windows/Hosted 仍需 QA。
4. **Tool-first（已於 Pathcraft 實作，本地驗證 PASS）：** SDK 接受 0～64 個 Host Tool、同一 Turn 可依序呼叫多個 Tool，Rust 無 Pathcraft 名稱／角色白名單，Server 將 `tools.json` Manifest 動態載入。尚須獨立 QA、真 Provider 與跨平台驗收；不等於已完成獨立 Runtime Kit。
5. **可分發 Artifact**：產生 npm 可安裝的 SDK build (`.js` + `.d.ts` + exports)；對應平台 Worker Binary 與 Rust crate 來源清單、checksum、license/SBOM、Code Signing/Notarization（需要時）、明確的安裝／解壓路徑策略；不能只交付 TS source 或 Rust Workspace。
6. **穩定 Transport contract**：明確版本化 SDK↔Worker 協定能力與錯誤；建立 binary discovery/version handshake、優雅的 mismatch error、日誌 redaction、structured diagnostics；保留 IPC v1 向下相容的驗證策略。
7. **解耦 Provider/Role 能力**：六個 Provider 皆有 CLI Host Tool 路徑，Role 能力由 Host 計算（Pathcraft 在 `provider-admission.ts`），SDK 不含角色語意。擴大 Admission 需補真實 Gate A/B、版本／平台證據、Provider model/effort 查詢及負向測試，不能只修改字串或 compiled capability。
8. **Doc-driven integration**：用**全新、沒有 Pathcraft 原碼引用**的 Node 範例 App 消費正式 artifact，驗證開立/送出/Tool/取消/結束/Worker crash/cleanup；macOS、Windows、Linux 逐一實機測試，確認 Host 不需要懂 IPC。

### 未來公開 API 原則（Proposed）

- 外部只 import 單一 SDK 入口；不需直接 import Rust Worker、IPC Protocol 或 SDK 內部 Transport。
- 必要選項只與使用者語意有關（Provider、Model、工作目錄、Tool、Session 身分），內部 Worker path/Spawn/Timeout 有合理預設；安全敏感設定留給**可信宿主**。
- Session 事件包含足夠的 Turn/Tool correlation，且**不把 transport ACK 視為業務完成**。
- 公開的錯誤型別穩定且不洩漏 secrets；未知 outcome 明確標示且永不自動 retry。
- 未來 Session Monitor 若納入 Kit，對外應是**唯讀 observer**；不能讓 Monitor 重入 Tool Handler 或改變 ACK 順序，UI/Tray 仍留在各宿主產品。

## 五、移植步驟（執行者 Checklist）

- [ ] 明確 SDK + Worker + Rust crates 版本及 license；保留 Rust runtime 的真實相依，不做 greenfield 重寫。
- [ ] 整理 consumer-facing API/types/errors/events；Server business adapter 留在原 Pathcraft。
- [ ] 選擇 npm publish、私有 registry 或本地 package tarball；提供 lockfile reproducibility 與相依版號。
- [ ] 為每種 OS/arch 編譯 Worker，建立 manifest + checksum；安裝時可檢查版本、權限、可執行性。
- [ ] 配好 Worker binary discovery、Rust Provider 前置程式與不可用時的分類錯誤；避免將 secrets 寫入 argv、URL 或公開 log。
- [ ] 用**外部獨立 repo** 跑 hello world、Tool、Session 結束與程序清理；不可單靠 Pathcraft 內部測試宣稱移植成功。
- [ ] 必過 P0 late event/Tool/ACK fail-closed、timeout/no retry、sequence、provider crash、cross-session isolation。
- [ ] 做宿主 ACL/Path containment、Tool durable commit 驗證；SDK 不替宿主管理 SQLite 或 Run。
- [ ] 每個平台實際跑 node + Rust Worker + provider，驗證子程序樹在正常退出與強制結束時均能收斂。
- [ ] 更新 Changelog/Release Gate 與 Consumer Migration Guide；沒有獨立驗收前維持 private/experimental。

## 六、驗收矩陣與證據入口

| 驗證 | 現有資產 | 抽離完成前必須新增的證據 |
| --- | --- | --- |
| SDK typed contracts | `packages/pedelec-node/test/session-contract.test.ts`、`npm run test:sdk`、`npm run typecheck:sdk` | P0 negative tests、獨立消費者 TS compile/test。 |
| IPC protocol / process | `packages/pedelec-node/test/rust-worker.test.ts`、`tests/rust-ipc/contract.test.mjs` | Artifact binary version/path mismatch、跨 OS/arch、異常 kill/tree cleanup。 |
| Boundary | `packages/pedelec-node/test/boundary.test.ts`、`npm run check:sdk-boundary` | 外部 App 不能 import private transport；消除 Pathcraft 業務相依。 |
| Server regression | `tests/agent-session`、`tests/agent-execution`、`tests/run-driver` | Pathcraft Server 消費新 artifact 的 e2e，且保留業務 ACL/Commit/No-Resume。 |
| 獨立 QA | `implementation/remaining/09_INDEPENDENT_ACCEPTANCE.md`、`reports/10-review-2026-11-03.md` | 外部消費者與平台 E2E；P0 Gate PASS 才可宣告 Release Ready。 |

## 七、既有與後續文件關係

- **SDK Consumer API（唯一開發者入口）**：`packages/pedelec-node/docs/DEVELOPER_GUIDE.md`。
- **SDK 現行簡介／ parity／import map**：`packages/pedelec-node/README.md`。
- **原始重構契約**：`implementation/Archived/10_PEDELEC_NODE_SDK_REFACTOR.md`。
- **已知 P0 與只讀 Monitor 前置 Gate**：`implementation/Archived/11_SESSION_EVENT_MONITOR_PROPOSAL.md`。
- **回歸證據與 Release backlog**：`implementation/Archived/reports/10-review-2026-11-03.md`、`docs/release/VERIFICATION_BACKLOG.md`。

**目前判定（2026-11-04）：** SDK/Worker 的 Tool-first 變更已在 Pathcraft repo 實作並通過 Mac 本地合約測試；M0 P0 修正與 Monitor 已 Coding PASS（未獨立 QA）。**獨立 package、binary 發行、外部 repo E2E、跨 OS/Provider 驗收仍未完成**，不能把本手冊的未來規劃誤認為已交付。
