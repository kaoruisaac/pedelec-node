# Pedelec Node — Backlog

> 2026-11-09 確認。下列項目不屬於 MD01／MD02 必須完成的 Coding Scope；不能假裝已支援。

| ID | 項目 | 範圍 | 狀態 |
| --- | --- | --- | --- |
| PN-B001 | Ollama Provider 原生 Level 1 Trace | 涉及修改 pedelec-agent 的 turn/tool_call、turn/tool_result、stdout/stderr 等；**此次先不改 pedelec-agent**。可保留已存在的觀測，Coverage 務必標 partial/unsupported/NOT RUN | Deferred by User |
| PN-B002 | Linux Alpine / musl | 若需容器 Alpine，另建 musl binary、依賴及驗證；初版 Linux x64 明確只支持 glibc Debian/Ubuntu | Backlog |
| PN-B003 | macOS x64、Linux arm64、Windows arm64 | native binary 與跨平台 Consumer QA | Backlog |
| PN-B004 | Durable Trace Delivery | SDK 目前 best-effort observation；跨程序 crash-proof／exactly-once、Host persistence 與業務級 SOP 評估不屬本 SDK 第一階段 | Backlog |
| PN-B005 | 跨 Session Runtime Listener | 第一階段只有 session.onAgentToolEvent()；是否增加 runtime 層聚合 Listener 另案 | Backlog |
| PN-B006 | Level 2/3 Tool Trace | Shell 子程序、Browser DOM 行為、OS syscall、網路逐筆攔截不屬 Level 1 | Backlog |

## 不得誤列為 Backlog 的首發必做

- **Linux x64 glibc + Container Consumer 驗證是 MD02 首發正式需求，不是 Backlog。**
- macOS arm64／Windows x64 Native 包裝與 QA 是首發正式需求。
- Codex／Claude／OpenCode／Cursor／Antigravity Provider Adapter 與 Coverage 報告是 MD01 的本次工作；協定不足可標 BLOCKED，不可直接省略。
- Pathcraft Desktop 的 npm Consumer 替換與重複原始碼清理是 MD02 必須完成的 Gate。
