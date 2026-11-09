# Coding Agent Prompt — MD01

請先讀 /Users/isaaclin/workspace/docs assistant/pedelec-node/requirements.md 與 implementation/01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md，完成 **Level 1 Agent Tool Trace + session.onAgentToolEvent** 的全部 Coding 與自行測試。

目前 source 仍在 ../pathcraft-desktop/packages/pedelec-node/、../pathcraft-desktop/rust/crates/。先讀 git status，保留所有並行未提交改動，不 reset/clean。只修改 SDK/Rust Worker／本階段 Provider Adapter／測試，不改 Pathcraft Host／Monitor，不搬 Repo、不 npm publish；**不修改 pedelec-agent（Ollama backlog）**。

務必落實 native/host correlation、readonly typed event、redaction、bounded async listener（不阻塞 Tool ACK）、gap/unknown、各 Provider fixtures 與真實 Provider Coverage matrix。協定缺失如實標 BLOCKED/NOT RUN，不能假稱 FULL。依 MD01 完整測試後附 diff、測試證據、殘留 blocker，僅最後一次交 User 驗收。