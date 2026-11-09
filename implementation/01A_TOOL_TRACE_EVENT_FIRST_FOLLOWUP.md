# 01A — Tool Trace Event-first Follow-up（MD01 修正）

- **日期：** 2026-11-09（Asia/Taipei）
- **狀態：** **2026-11-09 使用者驗收通過（Accepted with known limitations）**；證據見 [01A Evidence](../evidence/01A_EVIDENCE_2026-11-09.md)。macOS 真 Codex／Claude E2E PASS；OpenCode／Cursor／Windows／Linux NOT RUN，Antigravity BLOCKED。User 接受目前 Truncation 的極端容量邊界風險（詳 Evidence §8），非宣稱對所有輸入皆有嚴格 64 KiB 硬上限
- **產品：** Pedelec Node；原始碼現仍於 `../../pathcraft-desktop/`
- **順序：** 本 Follow-up 完成並驗收後才執行 [MD02](02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md)
- **參考：** [原 MD01](01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md)、[原 Evidence](../evidence/MD01_EVIDENCE_2026-11-09.md)、[Requirements](../requirements.md)

## 1. Confirmed 決策與契約覆蓋

**本文件是使用者最新 Tool Trace 決策；若與原 MD01／requirements.md 的 redaction、去重、補造 terminal、全域 Tool Record 等段落衝突，以本文件為準。此覆蓋僅限 Tool Trace，不改一般 SDK、Provider 的原生工作或 Monitor 原有安全規範。**

1. **不做 Tool Trace 敏感資料 Redaction。** Native／Host Event 對受信任的 Server Consumer 保留 Provider／Handler 回報的 command、args、stdout/stderr、output、title、toolName、path、URL 等欄位值；不遮蔽 Token、Credential、私有路徑。公開 SDK API 不是「可直接公開資料」的保證：Consumer 自行負責 ACL、UI/API 脫敏、記錄、持久化及 Retention。
2. **保留 Truncation。** 每字串／欄位／物件巢狀／整筆事件／IPC Frame 與 Listener Queue 都有硬上限；過長則截斷或省略、明示 `detailTruncated`／unavailable／gap。Truncation 為資源保護，不應被當作資料安全清洗。
3. **Trace 故障與 Provider 主流程隔離。** Tool Trace decode／normalize／emit／gap 派送失敗，不得造成 Provider Event Pump return/break、Tool ACK 失敗、Turn 異常或副作用 Tool 重跑。若共享 IPC 整體損壞，仍依既有主業務通道 Fault 契約，不得假裝成功。
4. **Event-first / minimal-state。** Agent／Provider 傳來 `started`／`updated`／`finished`，SDK 依收到的順序 Emit；only-finished 直接交付，同源重複 Notification 可照實交付。SDK **不持有完整 Tool Record Map**、不以歷史表推算 state、去重、推斷遺失階段，Turn terminal／crash 不合成 Tool `finished/unknown`。
5. **只留必要短期解析關聯。** Provider Adapter 得用小型、有界 Cache（如 Claude `tool_use_id → name`、ACP `toolCallId → title/kind`）補協定本來不重送的欄位；過期就回報 unavailable／partial，不推測。不得以此重新引進整個 Tool Lifecycle Manager。
6. **Host Tool 控制語意不變。** `session.onTool`、`pedelec-cli` Tool 及 Handler Result/ACK 原邏輯保持；新增 Trace 只在當下 Handler 上下文 emit。Native 與 Host 保留不同 source；親子關聯只用明確、可信、已知 ID，無法判定便 `unlinked`。
7. **API 不改名。** `session.onAgentToolEvent(listener): Unsubscribe`、既有 AgentToolEvent 公開型別與可得 metadata 保留；Source、ID、Turn、Status、Coverage、Truncation、Unsubscribe 等語意需文件化。維持無永久 SDK Trace Store。

## 2. 現有原始碼稽核位置

| 路徑（相對 `pathcraft-desktop/`） | Follow-up 修改 |
| --- | --- |
| `packages/pedelec-node/src/agent-tool-trace.ts` | 移除 `TraceSanitizer` 的 secret/key/path Redaction；保留 Byte Bounds。移除 `records`、`byKey`、`remember`、`closeOpen` 的全生命週期追蹤和 `maxRecords=4096` |
| 同檔 Native 路徑 | 去除 Map-driven dedupe、`started → updated` 修正、synthetic unknown、late outcome、跨事件 command/args 親子掃描 |
| 同檔 Host 路徑 | `hostStarted/hostUpdated/hostFinished/hostRefused` 改使用 invocation-local context／可傳遞 ID，不靠長期歷史 Record Map；保持真實 Handler/ACK 事件 |
| `rust/crates/pathcraft-ipc-worker/src/tool_trace.rs` | `bound()` 不再依敏感 key 遮蔽值；`emit_observations` 錯誤要與主 Pump 隔離；保留大小上限、Provider 短期 Cache |
| `rust/crates/pathcraft-ipc-worker/src/providers/{codex,claude,acp,antigravity}.rs` | 檢查所有 Trace `?` 錯誤傳播／`is_err()` 終止路徑；純 Trace 故障不得切斷 Provider Event Pump |
| `packages/pedelec-node/src/{types,session}.ts`、`README.md`、SDK/Rust tests | 將「safe/sanitised public event」註解、舊 Redaction／合成 terminal／去重測試改成最新契約；不更改其他 Monitor Log 的 Redaction |

## 3. Event-first 精確語意

### 3.1 Native observation

- Provider 送 `started` → SDK 發 `started`；`updated` → `updated`；`finished` → `finished`。只收到 `finished` 仍直接發送，不需憑過去狀態補 started。
- Provider 重複送同一 frame，可以重複交付（各筆有 `sequence`）；不能因 **我們自己重複擷取同一 frame** 造成額外事件。Consumer 可按原生 ID＋時序自行 Dedup。
- 有 stable native ID，SDK 發出同一 Session＋Turn＋source＋native ID 對應的**穩定工具身份**；採 deterministic identity，不依賴 Map 才能拿到同一 `toolCallId`。必須保持 JSON 安全及長度界限。
- 不同 Session／Turn 不可合併；不明或 foreign Turn 不可全部用 `turnId=null` + native ID 假裝同一呼叫。缺 native ID／Turn 時 Event 仍交付，mark partial/unavailable；沒有證據便不能承諾後續關聯。
- `status`、`exitCode`、input／output 僅該筆 Provider Event 具證據才提供；沒有明確 exit code 不補 0，沒有 Result 不補 success。可有 adapter 層必要 ID Cache 補 `name/kind`，但須可追溯。
- Turn normal terminal、cancel、close、crash：**不遍歷所有 Tool 並捏造 `finished/unknown`**。若 Trace/IPC 確有丟失或中斷，emit 有界 observation-gap／coverage 降級；Consumer 自行判斷未見 finished 代表什麼。
- P2 附帶修正：未知／foreign Turn 的同 native ID 不得產生不同 Turn 誤併；在 stateless 模式自然分開事件，不以 null 合併。

### 3.2 Host observation / parent

- Host invocation local scope 可保存 `hostToolCallId`、Turn、Tool 名、開始狀態；直接輸出 Handler 開始／回傳／結束所真正觀測到的 Event。可用必要的小型 invocation context，但不能保存跨 Turn 歷史完整 Tool Records。
- Handler 成功 ≠ CLI Reply 寫出 ≠ Provider 已 ACK；各階段沒有觀察證據就不可聲稱已成功送達。拒絕／錯誤／取消仍有 Host Trace，不能改 handler 工作結果。
- `pedelec-cli tool-spec` 不虛構 Host Handler Invocation；真正 `tool-call` 到達 Host 才有 Host Event。Native 外層 Shell 與 Host 內層是**兩筆不同來源**，不合成單筆。
- `parentToolCallId` 僅在協定明確 `parentNativeToolCallId` 或直接 invocation context 帶可信 parent ID 時填；取消跨事件 command text/JSON args 碰巧相同的回溯掃描。可保留 event-local `hostInvocations` 作提示，但不能把字串推測當已證實父子關聯。
- 若無法直接得可信 parent，回報 `unlinked`，不必做 Host/Native 強制配對。

### 3.3 Gap、背壓、容量

- 僅在 Trace 實際漏失／失敗、Listener Overflow、Provider 明示不支援／觀測不足時報告 gap/coverage；正常 Turn Terminal 不是 Tool 結束的證據。
- 保留原上限基線：command 4 KiB、stdout/stderr 各 8 KiB、input 16 KiB、output 24 KiB、event 64 KiB；Rust 原 IPC frame 限制、物件 max-depth/max-entries 同樣保留。超量要可辨識的 `detailTruncated`／gap，不能靜默丟掉。
- 每 Listener queue 原 256、非同步隔離／慢 listener timeout／throw/reject/unsubscribe／重入皆保留。只要 Observer 出錯，不阻塞業務 `onTool`／`onTurnEnded`。
- 不再保留 SDK `maxRecords` 或完整 Tool State Map。Rust Provider Adapter 的短期 ID Cache 應有**真硬上限**與淘汰政策，4,150 次只有 started 的事件不能使記憶體持續成長；淘汰時缺必要資訊必須標註。
- Trace 不再自己產生 `detailRedacted: true` 或 `[REDACTED]`；若相容性保留選用欄位，只能報告**上游明確聲明已遮蔽**的事實，不可宣稱資料安全。不得順手移除 Monitor／Server Log 的原有安全清洗。

## 4. Trace 失敗不能終止 Provider Pump（P1-1）

1. 稽核所有 `emit_observations(...)?`、Antigravity `is_err()` 與 Worker Trace Pipe；將 Trace-only Error 從主 Provider Pump 處理鏈隔離。
2. 透過 **fault injection** 模擬 Trace Serialize／Emit／Gap Emit 失敗。主 Provider Event／Tool Result／Turn Terminal 繼續傳遞；主 Tool Reply、ACK、Provider 完成結果與無 Trace 基準一致。
3. 如果共用 stdout／IPC writer **本身損壞**，主業務原本就不能交付事件，仍應依既有 Fault 流程處理；不能無條件吞掉每個 I/O Error 來假裝 Agent 成功。
4. Gap 傳送失敗時不能遞迴再送 gap、不能把 Error 往 Pump 冒泡；可採有界計數／下一筆可交付的 gap，若整個通道失效則保留不可確認狀態。

## 5. Coding 作業及驗收 Gate

**工作範圍**：只改 `pathcraft-desktop/packages/pedelec-node/`、`pathcraft-desktop/rust/crates/pathcraft-ipc-worker/` 的相關檔案、測試、SDK README；此輪不改 Pathcraft Server/Monitor/UI/Graph/DB，不修改 `pedelec-agent`，不執行 MD02 Git Repo/npm 封裝、發布、Consumer 替換。`pathcraft-desktop` 工作樹已有 MD01 未 commit 更動，開始先 `git status`；不得 reset/clean/覆蓋其他人修改。

- [ ] Raw fidelity：使用**假的** Authorization／Cookie／API_KEY／URL Credential／Private Path canary，測試 Native input/output、ACP title、ToolName、Host Args 在**未截斷**時完整交付且不被 SDK 替換。
- [ ] Truncation：長 command／stdout／stderr／args／巢狀物件／IPC Frame／Event，證明上限有效並標 `detailTruncated`／gap，不能假稱完整。
- [ ] Event-first：started、updated、finished、only-finished、重複 Provider Event、不同 Session/Turn、缺 native ID、未知 Turn、晚到事件、Turn terminal/crash **不合成 Tool finished**；相同 native ID 有穩定 identity。
- [ ] Host Handler：成功／失敗／denied／cancelled、CLI Reply 與 ACK 區別，`tool-spec` 不假造 Host Event；Native/Host 不因去重失去 provenance，parent 只在可信證據填入。
- [ ] Adapter Cache：Claude tool_use/result、OpenCode/Cursor ACP partial update 證實必要 ID Cache；容量硬上限、淘汰測試（至少 4,150 筆）後仍有正確 partial/unavailable，無全域 SDK Tool Record 成長。
- [ ] Fault injection：trace-only emit、parse、gap emit 的錯誤都不造成 Provider Pump 提前斷線；與整條 IPC 損毀場景**分開**驗證；Antigravity 一併測試。
- [ ] Listener isolation：無／慢／throw／reject／unsubscribe／重入／Queue Overflow，Trace 永不阻擋工具和 Turn 主結果。
- [ ] 正常回歸：`npm run typecheck:sdk`、`npm run test:sdk`、`npm run check:sdk-boundary`、`cargo test --manifest-path rust/Cargo.toml -p pathcraft-ipc-worker`、相關 Server typecheck/測試；沒有 Bun 則記 NOT RUN。
- [ ] Provider 證據：Mac Codex/Claude 真 Native Shell、非 Shell（可行時）、CLI Host Tool E2E，更新每家 PASS/FAIL/BLOCKED/NOT RUN，不可把 fake provider 當真實 Gate B。
- [ ] 更新 README／JSDoc／fixtures／測試、寫明新舊契約差異；更新 `pedelec-node/evidence/` 的驗收證據、測試與所有待辦；原 MD01 未達真 Provider Gate 不可宣稱已 PASS。
- [ ] 提交最後變更與 QA 報告供**一次** Human Review；無未修正 FAIL 且真 Provider Gate 達標前，不進 MD02。

## 6. 建議實作順序

A. 檢查現有 diff 與舊測試 → B. 移除兩端 Trace Redaction（留 Truncation）→ C. Event-first／ID／Host scope／minimal Adapter Cache → D. Trace Pump Fault Isolation → E. 改寫合約測試和整體回歸 → F. 真 Provider QA／Evidence。**只修改 Tool Trace，切勿順便重構 Provider 工作流程。**