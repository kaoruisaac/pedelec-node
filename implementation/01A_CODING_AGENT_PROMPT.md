請在 Mac mini 上完成 Pedelec Node 的 MD01 Follow-up：

`/Users/isaaclin/workspace/docs assistant/pedelec-node/implementation/01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md`

先閱讀原 MD01 與既有 Evidence，確認 `pathcraft-desktop` 最新原始碼及 `git status`，保留所有未提交變更，不 reset/clean。現階段只修改 `pathcraft-desktop/packages/pedelec-node/` 與 Rust Worker 相關原始碼／測試。

重點：**Tool Trace 取消 Redaction、保留 Truncation**；**trace-only emit/parse/gap 失敗不得終止 Provider Event Pump**；**SDK 改為 Event-first，不保留完整 Tool Record state/map、不補造 tool terminal、不強制去重**；Provider Adapter 僅允許必要、有界的協定 ID Cache。保留 `onAgentToolEvent`、Host Tool 原行為與 Listener 隔離；不確定的關聯標 partial/unlinked。

請連續完成實作、故障注入與回歸測試，盡可能跑 Mac 真 Codex/Claude E2E，更新 README、測試及 `pedelec-node/evidence/`，最後回報改動、測試 PASS/FAIL/NOT RUN、Provider Coverage、剩餘阻礙。**不修改 Pathcraft Host/Monitor/UI/DB，不做 MD02 Repo/npm 遷移，不宣稱未驗收的 Provider PASS。** 一次實作完成後再交我驗收。
