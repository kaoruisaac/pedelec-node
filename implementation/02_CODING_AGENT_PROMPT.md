# Coding Agent Prompt — MD02

完成 MD01 並交付可驗證 Code Diff／Coverage 後，請讀 /Users/isaaclin/workspace/docs assistant/pedelec-node/requirements.md 與 implementation/02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md。

以現有 /Users/isaaclin/workspace/docs assistant/pedelec-node/ 作獨立 Git 工作根，建立全新 Public GitHub Repo **kaoruisaac/pedelec-node**（不合併舊 pedelec），發行單一 Public npm **@kaoruisaac/pedelec-node**。SDK + Rust IPC Worker / pedelec-agent / pedelec-cli 須同包提供 macOS arm64、Windows x64、Linux x64 glibc Native；Docker Debian/Ubuntu non-root consumer 與另兩平台真測試不能省略。不要再依賴 Pathcraft 原碼、Node workspace 或舊 rust/target binary。

先確保外部乾淨 Consumer npm pack/install + session/tool trace/onTool + cleanup PASS、授權／Secrets／Checksum Gate PASS，才能公開 publish；接著把 Pathcraft Desktop 全面改為這個 npm consumer 並做 build/tauri dev/build、Session/Host Tool/Monitor/Provider 回歸，最後安全移除舊 SDK/重複 Rust 實作。保留 MD26/MD27 等未提交變更；不要 reset/clean。Ollama pedelec-agent Trace 改動仍是 backlog。所有 test/Release/Windows/Linux Docker 狀態如實報告，最後一次 User 驗收。