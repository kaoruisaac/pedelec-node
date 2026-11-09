# Pedelec Node — Project

- **建立日期：** 2026-11-09（Asia/Taipei）
- **狀態：** Active — **01A Event-first Follow-up 2026-11-09 使用者驗收通過（容許已知 Truncation 邊界限制）**；SDK/Rust 回歸 PASS、macOS 真 Codex／Claude Gate B PASS；其餘 Provider/平台 QA 尚未覆蓋；MD02 獨立 Repo/source 已建立，公開 npm／跨平台驗證／Pathcraft Migration 尚未完成（NOT ACCEPTED）
- **專案目標：** 通用 Node/TypeScript Agent Runtime SDK，內含 Rust IPC Worker、Runtime、pedelec-agent、pedelec-cli，可獨立於任何業務 Consumer 使用
- **工作區（Mac mini）：** `/Users/isaaclin/workspace/docs assistant/pedelec-node/`
- **工作區（Windows）：** `C:\workspace\Projects\pedelec-node`；兩台電腦以 **Syncthing 雙向同步**同一份專案原始碼（使用者 2026-11-09 確認）。
- **Git／發布主控：** **Windows 為準**，與既有 `pedelec` 專案作法一致。Git Remote 設定、Commit／Push、tag、GitHub Release、npm publish 優先在 Windows 執行；Mac mini 可進行編輯及 macOS 驗證，不以 Mac mini 的發布權限為前提。Syncthing 同步不等於 Git 推送或 npm 發布。
- **未來公開 GitHub Repo：** https://github.com/kaoruisaac/pedelec-node（目標，未建立／未核實）
- **未來公開 npm：** @kaoruisaac/pedelec-node（目標，未發布／未核實）
- **來源快照：** ../pathcraft-desktop/packages/pedelec-node/、../pathcraft-desktop/rust/crates/
- **產品邊界：** 與舊 kaoruisaac/pedelec（Browser Extension／Desktop bridge）及 Pathcraft Desktop 業務完全獨立；兩者僅當 Pedelec Node Consumer／歷史來源

## 已確認的決策（2026-11-09）

1. SDK Session 事件 API 為 **onAgentToolEvent(listener)**，純觀測；原 Host Tool Handler **onTool(name, handler)** 保持不變。
2. 第一份實作：Level 1 Native Tool／Host Tool Trace + Listener、Provider Adapter、SDK/Worker tests；**不接 Pathcraft Host／Monitor**。
3. **最新 01A 決議（覆蓋舊版 redaction/stateful 要求）：** Level 1 保留 Provider 原值，不在 SDK Trace 做 Secrets／Private Path Redaction；仍有 Truncation 與 Gap。Trace emit 壞掉不得斷 Provider Pump；採 Event-first、不維護完整 Tool Record／不合成 unknown terminal，僅保留解析協定必須的有界短期 ID Cache；不抓 reasoning 或 Shell/Browser 內部每一步。
4. Provider逐一驗證；真協定不可得允許 **BLOCKED**，不得宣稱六個全 PASS。**Ollama 要修改 pedelec-agent 的部分先列 backlog，不在第一份實作修改。**
5. 第二份實作：獨立新 Repo、全新 Git History、**一個公開 npm package**，SDK+三類 native binary 的正式發行。
6. 發行平台 **macOS arm64、Windows x64、Linux x64**；Linux 需 Docker（Debian/Ubuntu glibc）獨立 Consumer 測試；不將 Alpine/musl 視為已支援。
7. 公開 GitHub/npm 已獲使用者核准，但實際 publish 必須通過工程安全、三平台 Consumer QA 與授權檢查。
8. Pathcraft Desktop 完成 npm Consumer 遷移驗證後移除舊 SDK／重複 Rust Runtime，保留其業務程式；不破壞目前未提交工作樹。

## 文件入口

- [requirements.md](requirements.md)：唯一完整產品需求與範圍權威（原位於 Pathcraft Desktop，2026-11-09 歸屬轉移）
- [01 Tool Trace + Listener](implementation/01_LEVEL1_TOOL_TRACE_AND_SDK_LISTENER.md)：Coding Gate 1
- [02 Standalone Repo + npm + Migration](implementation/02_STANDALONE_REPO_NPM_AND_CONSUMER_MIGRATION.md)：依賴 Gate 1；含 Pathcraft Consumer
- **[01A Event-first Follow-up](implementation/01A_TOOL_TRACE_EVENT_FIRST_FOLLOWUP.md)**、**[01A Coding Agent Prompt](implementation/01A_CODING_AGENT_PROMPT.md)**：最新已確認的 MD01 收斂與驗收需求（優先於舊 MD01 牴觸條款）
- [01 Coding Agent Prompt](implementation/01_CODING_AGENT_PROMPT.md)、[02 Coding Agent Prompt](implementation/02_CODING_AGENT_PROMPT.md)
- [BACKLOG.md](BACKLOG.md)：已核定延後及後續探索事項
- 歷史背景：[../pedelec-memo/proposals/P-003-independent-pedelec-runtime-kit.md](../pedelec-memo/proposals/P-003-independent-pedelec-runtime-kit.md)

## 目前狀態與下一步

- **已完成：** 子專案與初版 MD01/MD02 文件；MD01＋01A 原始碼與 Fake Provider／SDK/Rust 基線測試、Mac Codex／Claude 真 E2E 已落地；01A 實作 MD／Prompt 已建立且 User Accepted；`pathcraft-desktop` Commit／Push `365a625`。
- **01A 進度：** 實作、故障注入與回歸完成，證據見 [01A Evidence](evidence/01A_EVIDENCE_2026-11-09.md)；**2026-11-09 Human Review：使用者驗收通過，原始碼已在 `pathcraft-desktop` 的 `main` Commit `365a625` 並 Push 至 `origin/main`，工作樹乾淨**。已知例外：大量 `hostInvocations` 可讓單筆 Event 超出標示的 64 KiB；超長 JSON Key 未遵守字串上限／未標記截斷。使用者接受現有防護，列入後續技術債；不能將上限描述為對所有輸入均保證硬限制。
- **MD02 現況（2026-11-09 Mac 唯讀驗收）：** 獨立 Git `main` 與原始碼已建立（本地 `e74aa1c`）；SDK typecheck／boundary PASS、Vitest 188 PASS／1 skipped。Mac 本地 Native bundle 僅 darwin-arm64；缺 Windows/Linux bundle 導致 `check:package`、`npm pack --dry-run` FAIL；未設定 Git Remote，npm 公開版尚未確認，Pathcraft Desktop 仍使用 `@pathcraft/pedelec-node`。**MD02 NOT ACCEPTED**；新工程來源已實作，並非整份未開始。
- **尚未完成：** 使用者預計先在 **Windows 主控端**進行 Git／推版；GitHub Repo／npm Release、三平台 CI/Consumer、Linux Docker／Windows Native、Pathcraft Consumer 替換仍待驗證。Mac mini 無足夠發布權限，不在此機強行 publish；OpenCode／Cursor／Windows／Linux 真 Provider Gate B 與 Truncation 技術債仍待處理。
- **執行順序：** 01A 已由使用者驗收通過 → 可進 MD02 建 Repo／三平台驗證／公開發行／移轉 Consumer → 再做一次 Human Review；各平台 Provider 覆蓋應維持真實 PASS／NOT RUN／BLOCKED。
- **版本同步工具（2026-11-09）：** 新增 `npm run version 0.0.1`，同步更新 npm SDK package/lock 與 Rust Workspace/六個 crate 的 Cargo.lock；隔離副本實測 PASS。刻意不改既有 Native Binary／Manifest（版本更新後須重新建置全平台並產生 Manifest 才能 Release），不自動 Git Commit、Tag 或 Publish；發版仍以 Windows 為準。
- **Tag-only npm Release（2026-11-09）：** 參考原 `pedelec/.github/workflows/release.yml`，版本 Tag 採 `v<SemVer>`（例如 `v0.4.0`）；`pedelec-node/.github/workflows/ci.yml` 的 `release` 僅在 `push` Tag 時執行。普通 `main` Push／PR／workflow_dispatch 不會 publish；Tag、SDK npm 版本／lockfile、Rust workspace 必須相符，三平台 Native／Consumer／Docker Gate 必須通過，npm 已存在版本跳過，缺 npm credentials／Registry 查詢錯誤則 fail。Git Tag Push 與 Release 主控為 Windows；尚未執行真 Tag/CI/npm 發布驗證。
- **Vitest／Native 測試修復（2026-11-09 Mac PASS）：** SDK 升至 0.4.0 後，本機 `bin/manifest.json` 殘留 0.1.0，造成 129 個 `NATIVE_MANIFEST_MISMATCH` 測試失敗；已在 `package.json` 新增 `pretest`（Rust Debug 增量編譯 → Stage 本機 Native → 重新產生 Manifest），CI 調整為 SDK tests 先於 Release build/stage，確保正式 Artifact 仍採 Release Binary。Mac 重新執行 `npm test` **188 PASS／1 skipped／0 failed**，typecheck／boundary／git diff --check PASS；Windows/Linux CI 尚未實際執行。`npm run version` 仍不自動重建跨平台 Release Bundle。
- **三平台 CI 故障修復（2026-11-09；Local Verified，CI Retest TBD）：** GitHub Actions Run `42585083582` 的 macOS/Linux SDK 9 項失敗來自 Fake Claude/ACP 檔案 Git mode `100644`；使用者已在 Windows Git Index 將兩檔設為 `100755`。Windows Rust stdin 測試因 Fixture `.cmd` 使用 `more` 改寫 CRLF／尾隨換行，已改為 PowerShell 原始位元組複製。Windows 完整 Rust Workspace **369 passed／5 ignored／0 failed**；另外修正 Antigravity Windows 假 Provider `python -X utf8`、跨平台絕對測試路徑、Cancel 成功後退休 Session，Windows Antigravity **10 passed／1 ignored**。Mac 完整 Rust Workspace **271 passed／3 ignored／0 failed**、Vitest **188 passed／1 skipped**。`write-manifest.mjs` 略過 Syncthing 產生的不完整非本機平台目錄，`--require-all` 仍會因缺 Win/Linux Native fail，確認不放寬 Release Gate。GitHub CI 及真跨平台 npm Consumer/Docker 仍待 Push 後驗證；Mac 不接管 Windows Git／Tag／Publish。
- **工程注意：** Pathcraft Desktop 有 MD26／MD27 與其它未提交變更，禁止 reset/clean；當期實際來源以開始 Coding 時最新狀態為準。
