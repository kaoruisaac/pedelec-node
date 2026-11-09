# 01 — Level 1 Agent Tool Trace + SDK Listener

- **日期：** 2026-11-09
- **狀態：** 已有未提交實作；Unit／Fake Provider Gate A 已測，真 Provider Gate B 未驗收。後續修正見 [01A Follow-up](01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md)
- **產品歸屬：** Pedelec Node；完整權威參見 [requirements.md](../requirements.md)
- **原始碼工作位置（本階段）：** ../pathcraft-desktop/packages/pedelec-node/ 與 ../pathcraft-desktop/rust/crates/
- **交付：** 公開 SDK Typed Listener、跨 Provider 正規化 Native Tool + Host Tool 觀測、測試與 Coverage 報告
- **禁止範圍：** 不建立／搬移 Repo、不 npm publish、不修改 Pathcraft Host／Monitor／UI／Graph／資料庫、不變更 pedelec-agent
- **新契約優先：** [01A Event-first Follow-up](01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md) 取代本 MD 原有的 Trace Redaction、全域 Tool Record、跨 Event 去重及 synthetic tool terminal 需求；本文未修改的部分仍適用。

## 1. 目標、完成定義與既有契約

1. Agent 自身呼叫 Provider Native Tool（Shell／File／Search／MCP／Browser 等 Provider 有暴露的 Tool），SDK 對每筆呼叫交付可關聯的 Life-cycle Event 與已知結果。
2. SDK Host Tool 經既有 pedelec-cli → onTool(name, handler) 的路徑執行，不改執行或 ACK 流程；新增同一格式的觀測 Event，與原生外層 Shell 有證據時才建立父子關聯。
3. API 固定為 **session.onAgentToolEvent(listener): Unsubscribe**；不是 onAgentLog、onAgentTool，也不取代 onTool。
4. 事件含安全處理過的 command／arguments／stdout/stderr／exit code（Provider 有提供才有）、來源、ID、時間、狀態與缺口證據，不包含 reasoning、原始 protocol 全文或 Shell 內部每個子程序。
5. Tool Trace 是旁路觀測；無 Listener、慢 Listener、throw/reject、Cancel／Crash 均不改 Provider 執行、不造成工具重跑或 ACK 失敗。SDK 無永久 Trace Store。

## 2. Baseline 與要先檢查的真實檔案

- **packages/pedelec-node/src/index.ts、types.ts、session.ts、events.ts、monitor.ts**：現有 Session / Unsubscribe / onTool / onTurnEnded；尤其 events.ts 的 ListenerSet.emit 會 await 每個 Listener，**不可直接把 Trace 掛進會等待的 eventQueue**。
- **src/transport/rust-ipc.ts、rust-ipc-supervisor.mjs**：只在受信任 internal transport 新增 Tool Event，不透過 detailedMonitoring 或 PATHCRAFT_MONITOR_DETAILS 取代。
- **rust/crates/pathcraft-ipc-worker/src/providers/**：實際 Codex/Claude/ACP/Cursor/Antigravity 通知來源；先建立真協定 fixture 再做映射。Worker crate 路徑仍屬當前來源，正式 rename 留給 MD02。
- **src/session.ts 的 handleToolRequest、cli-endpoint.ts**：Host Tool handler start／finish／ACK 三者語意各異，觀測不能把 handler success 假裝 Provider 已 ACK。
- **test/fake-transport.ts、session-contract.test.ts、rust-worker.test.ts**：拓展 protocol-level 與 listener isolation 回歸。
- Coding 前先抓最新 source 與 git status，MD25/26/27 異動不可覆蓋，禁止 reset --hard / git clean / 順便重構無關功能。

## 3. 公開 TypeScript API（須按此落碼）

~~~ts
const unsubscribe = session.onAgentToolEvent((event: AgentToolEvent) => {
  // readonly; Host 可以自行持久化/分析，不提供執行控制。
});
unsubscribe();
session.onTool('configureTool', async (args, context) => ({
  success: true, result: { accepted: true },
}));
~~~

- 型別於 src/types.ts 定義並從 src/index.ts export；Callback 支援 void | Promise<void>，可重複註冊、取消訂閱、同 Session 多 Listener。
- 核心 AgentToolEvent：Readonly，sessionId、turnId: string | null、provider、source: provider-native | pedelec-host、kind: started | updated | finished | observation-gap、toolCallId、nativeToolCallId?、parentToolCallId?、toolName、toolKind: shell | file | browser | search | mcp | host | other | unknown、at、status?、exitCode?、input?、output?、errorCode?、coverage?、detailTruncated?。
- input/output 為 **已清洗的有界摘要**，不是任意原始 payload；需要增加 field 時保持可 JSON 序列化、Readonly，且外部無法存取 SDK 私有 handle、Rust transport、認證與原始封包。
- 對缺失資料在事件中可附 detailUnavailable、detailRedacted 或具體 availability flags；不得以空字串當作真 stdout、0 當作未知 exit code。
- 不要求 runtime.onAgentToolEvent 聚合入口；不宣稱 Trace 是 durable/全保證。

## 4. Worker → SDK 訊息流與 Normalizer

1. 在 Rust Worker 的 Provider Adapter 先識別原生事件，轉成**內部 typed Tool Observation**；必須帶 Session/Turn/Provider、source、原生或產生的 call ID、Lifecycle、時間及原生證據的安全界線。
2. 透過既有 Rust IPC 有界傳送事件（例如新增 event kind agent-tool）；保持原始 provider.rpc / monitor 的原有用途與相容行為；SDK transport 解碼後交由 Session Normalizer。
3. SDK 按 sessionId + turnId + source + nativeToolCallId 關聯同一呼叫；有 stable native ID 必須沿用；沒有時只配對有足夠協定識別的 update，否則產生獨立 SDK ID、標 coverage partial/gap，**不可按時間猜測合併**。
4. started → updated* → finished；Provider 只給 finished 可單獨記錄；僅有 started 而 Terminal/Worker crash 的 outcome 必須為 unknown，不可推測 completed。
5. Status 只由工具層結果映射：completed / failed / denied / cancelled / unknown；Turn completed 不等於內部所有 Tool completed，Provider 未提供 exitCode 時不可補 0。
6. 重複通知用同一 toolCallId 去重或併成同次 lifecycle update；禁止同 Session 不同 Turn、不同 Session 的 ID 合併；晚到事件不可污染目前 Turn 或觸發 effect。
7. 同一 Agent 原生 Shell 呼叫 pedelec-cli tool-call 與 Host Handler 產生兩個**來源不同**的觀測。parentToolCallId 只在有可驗證 correlation 時填；否則保持 separate/unlinked，避免錯誤父子關係及錯誤的 SOP step count。
8. pedelec-cli tool-spec 是 Shell 的觀測，不要假造 Host Handler Invocation；真正的 tool-call 才形成內層 Host Tool。若 Host Handler 已完成但 ACK 未確認，觀測需分清 handler result 和 provider acknowledgement，不能宣稱 Agent 已收到結果。
9. Worker／Normalzer 出錯屬 instrumentation failure：正常 Tool 執行不能因此失敗；發出有界 observation-gap 和 coverage 降級。不得重試有副作用的 Tool。

## 5. Listener isolation、背壓與時序

- 禁止直接 await 現有 ListenerSet.emit 再推進 onTurnEnded／toolReply／eventQueue；另建**Session-scoped bounded Trace Dispatcher**：在事件 ingress 只驗證、快照、排隊；非同步逐 Listener 派發，保留同 Session 事件順序，但不等待 Listener 才處理工具業務。
- 建議初值：每 Session 最多 **256 個待派送 Trace Event**，事件序列化上限 64 KiB。慢 Listener／高頻事件超限時合併 gap 計數並降 coverage；**gap 必須最終可被下一次可派送觀測或明確 drain 看見**，不可無聲丟棄。
- Listener 同步 throw、async reject、重入、unsubscribe、close／ended 都不得 throw 進業務事件。回呼隔離錯誤可計入內部安全 Monitor counter，但不可遞迴無限生成 Trace Error。
- close／cancel／worker crash 的 queue 排水有明確有界政策；即使 crash 前 Event 遺失也要承認 best-effort，不能保證 exactly-once 或跨 Runtime 重啟補齊。
- 對敏感欄位必須先 sanitize 再放入公用 Listener Queue。訂閱零人不能改變原 Tool 執行；coverage/gap 的管理仍由 SDK 能力契約呈現。

## 6. 安全摘要與資料策略

- **B 深度**：Tool 名、可辨識的 Shell command、working-directory 安全提示、重要 args、stdout/stderr、安全結果、exit status；只有 Provider 明確提供時保留。
- 建議基線上限：command 4 KiB；input 16 KiB；stdout 8 KiB、stderr 8 KiB；單 event 最多 64 KiB；最終值以 tests 鎖定。長輸出附 detailTruncated，**不要把前 8 KiB 稱為全部 stdout**。
- 敏感 key（Authorization、cookie、token、API key、password、secret 等）、命令環境變數、帶憑證的 URL、private path 必須依安全規範隱藏；無法確認安全時省略細節並標示 redacted/unavailable，不能把任意 Raw Protocol 當成可公開的 Event。
- 單純 regex 不能保證偵測所有 secret；public API 預設只提供低風險摘要，透過 fixtures 測試常見洩漏；Trusted Debug 仍另走現有 Monitor 不擴張其 retention 或 public access。
- SDK 不實作 Host 的業務 Trace DB、Owner/ACL、Retention 或 Graph／SOP 效能判定。

## 7. Provider Adapter 與 Coverage 政策

| Provider | 本次工程範圍 | 需要的真證據 |
| --- | --- | --- |
| Codex | App Server item/started/updated/completed，Shell commandExecution 及非 Shell items | ID、command、stdout/exit、取消／出錯 |
| Claude | stream-json tool_use / tool_result 配對（Bash + 非 Shell） | tool_use_id、input/result、failure/interrupt |
| OpenCode | ACP session/update tool_call / tool_call_update | ID、kind、status、rawInput/rawOutput 可得性 |
| Cursor | ACP 相容但**獨立 Parser/Fixture** | 不借用 OpenCode PASS |
| Antigravity | step_update/result 能力探勘與可得事件映射 | 無法識別 invocation 必標 BLOCKED/partial |
| Ollama／pedelec-agent | **本次修改 Backlog**，不改 pedelec-agent；可盤現有事件，不能虛報 FULL | 項目見 ../BACKLOG.md PN-B001 |

- Q4 採 B：Provider 本身缺必要通知而不能可靠建 Tool Record 時，工程成果可交付，但該 Provider 必須標 BLOCKED。不得把 Provider 不支援解釋為「沒有調用 Tool」。
- 公布六 Provider × 平台的 PASS／FAIL／BLOCKED／NOT RUN 矩陣；未做真 Provider E2E 不能顯示 PASS。Provider 版本、環境、遮蔽後原始通知、Trace Event 與差異要可追溯。

## 8. Coding 作業順序（一次連續實作，最後一次 Human Review）

- **A — Source audit / fixtures：** 確認 MD25 最新生命週期、目前來源；為五個本次 Provider 取得 fixtures／事件映射；標出 missing fields 與 provider-specific 不確定。
- **B — Rust/Internal transport：** 加入原生 Tool Invocation/Result 的有界內部 event，避免依賴 detailedMonitoring；做 compile/test。
- **C — SDK typed listener：** Public DTO、Session API、Host Tool instrumentation、Normalizer、去重關聯、sanitizer、bounded dispatcher、Crash/gap coverage；更新 README/API 範例。
- **D — Tests：** Fake transport、Provider fixture、工具 success/failure/denied/cancelled、only-finished、duplicate、跨 Session/Turn、Host/native 混合與無法關聯、slow listener/reject/throw/unsubscribe、redaction/oversize、Cancel/Worker crash/outcome-unknown、既有 API regression。
- **E — 真 Provider：** 使用每 Provider 相同 Scenario：Native Shell exit 0/nonzero＋輸出、非 Shell Tool、pedelec-cli tool-spec/tool-call 成功/失敗、agent-browser CLI Shell 呼叫、連續工具、Cancel、Crash。真工具可用性不足明示 NOT RUN/BLOCKED。
- **F — Review：** 一份 evidence 報告、測試命令／結果、Coverage matrix、所有未達成項目；最後一次交 User 審閱。測試問題要先自行修復後再送審。

## 9. 驗收 Gate（全部必須能出證據）

- [ ] Public TypeScript 匯出 session.onAgentToolEvent、AgentToolEvent、Unsubscribe；既有 onTool/onChatDelta/onArtifact/onTurnEnded/onMonitorEvent 行為不回退。
- [ ] 正常 Provider Tool 走通且 Host Tool Handler 成功／失敗皆有 Trace；原生 Tool 和 Host Tool 的 Identity、來源、可驗證關聯準確。
- [ ] 事件 lifecycle + unknown／gap 與同 ID 去重、不同 Turn/Session、late event 的 contract tests PASS；Provider-specific fixtures 可重放。
- [ ] Listener 無/多/慢/throw/reject/unsubscribe/重入、高頻 overload 均不影響 toolReply/Turn 結局，無 unhandled rejection。
- [ ] 默認 Event 不洩露常見 secret／private path，長 command/output 明確 redacted/truncated；非 Debug 模式亦能收到事件。
- [ ] 真 Provider 覆蓋報告逐一記 PASS/FAIL/BLOCKED/NOT RUN（包含 Ollama Backlog），不假稱全六家 FULL。
- [ ] 目前 Pathcraft 工作樹未被覆蓋或清理，未更動 Pathcraft Host/Monitor/Server/DB；沒有 npm publish／Repo 遷移。
- [ ] 交付變更 diff、測試結果與後續 MD02 前置條件；若存在未修整的 FAIL 不可宣稱 MD01 PASS。

## 10. 非目標／重大風險

- 本階段不修改 pedelec-agent／Ollama Native Tool，亦不做 Linux packaging 或 Pathcraft Consumer 接線；這些分別屬 Backlog 與 MD02。
- Provider 未提供 exit code／stdout 並不是 SDK 可以自行推算的數據；需保留 unavailable 以及真協定證據。
- 若 Native Shell 與 CLI Host Tool 無可信 parent mapping，保留分開事件與 coverage limitation，絕不使用時間接近當作主鍵。
- SDK 目前 RAM-only Session Handle、50 ended FIFO、runtimeStorageRoot GC、ID-only resume、fail-closed／no-retry 規範維持；觀測不得加回 Session JSON。
