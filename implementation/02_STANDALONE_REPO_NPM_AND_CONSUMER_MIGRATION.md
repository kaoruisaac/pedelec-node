# 02 — Standalone GitHub Repo + Single npm Module + Pathcraft Consumer Migration

- **日期：** 2026-11-09
- **狀態：** READY FOR CODING；需 MD01 Level 1 Tool Trace 先完成並交付可驗證來源
- **產品歸屬：** Pedelec Node；產品要求見 [requirements.md](../requirements.md)
- **獨立本機目錄：** /Users/isaaclin/workspace/docs assistant/pedelec-node/
- **公開 GitHub Repo（目標）：** kaoruisaac/pedelec-node（全新 Git History；不合併 kaoruisaac/pedelec）
- **公開 npm 名稱：** @kaoruisaac/pedelec-node（唯一 npm module）
- **首發平台：** darwin-arm64、win32-x64、linux-x64-gnu；Linux server / glibc Debian／Ubuntu Docker 正式首發支援
- **兩個交付 Gate：** (1) 獨立 Repo / npm Artifact + 3 平台 Consumer，(2) Pathcraft Desktop 替換並清理舊實作；均未開始
- **發布決策：** 直接 Public GitHub + Public npm 已授權，但不能跳過 Release QA、安全掃描與第三方授權檢核

## 1. Scope 與不變的契約

- 由目前 Pathcraft Desktop 原碼拆出 Node SDK、SDK 私有 transport、Rust IPC Worker、pedelec-core/runtime/shared、pedelec-agent、pedelec-cli、共用 build/QA/release scripts、docs、License/Notices；**Git Repo 1 個、npm 套件 1 個**。
- 外部 Consumer 只需 npm install @kaoruisaac/pedelec-node，Public entry 建議只暴露 SDK、正式 types、必要的 provider probes；不要將 IPC 內部 frames、Rust transport／binary path 當穩定 public API。
- 維持 createPedelecRuntime、createSession、resumeSession(sessionId)、sendText、onTool、onAgentToolEvent、onChat/onChatDelta、onArtifact、onTurnEnded、cancel、close 的語意與 SDK fail-closed。
- 保留 runtimeStorageRoot 與 SDK Session-scoped Artifact/Provider State GC；最近 50 ended RAM handles；不恢復 SDK Session JSON 或新增跨 Runtime 重啟自動接回。
- Pathcraft Desktop **不是**新 Repo 的 dependency；Graph／Run／Task／Owner／ACL／SQLite／Host Tools／Monitor UI／Tauri asset pipeline 全留在 Consumer。已經打包的 agent-browser／Chrome 不搬入 Node module。
- 開始前檢查 Pathcraft Desktop 的未提交 diff 與 MD26/27；不准 reset --hard、git clean，不能先刪來源。若程式正在並行修改，先保留並以小範圍可回溯 commit／patch 交接，不覆蓋對方變更。

## 2. 新 Repo 建立與原始碼抽離

1. 目前這個 Docs Assistant 子專案已包含 project.md、requirements.md、implementation/ 與 BACKLOG；**此目錄成為獨立 Repo 工作根**，不再新增第二個同名 implementation workspace。
2. 在開始工程時於此路徑確認沒有現存 .git，執行 git init -b main，配置 Public Remote 為 https://github.com/kaoruisaac/pedelec-node；先核對 GitHub owner 授權及目標 repo 是否已存在，禁止覆蓋別人的 Repo。
3. 從 Pathcraft 原碼**複製必要的可編譯來源**進新 Repo，而不是 git submodule、symlink、或 npm file:../pathcraft-desktop；先建立新 Repo 獨立 build、測試，後續再清理舊來源。
4. 建議結構：src/（TypeScript SDK）、rust/Cargo.toml + crates/（必要 Native crates）、scripts/、test/、docs/、bin/<platform>/、package.json、tsconfig、LICENSE、THIRD_PARTY_NOTICES、README。
5. 把 pathcraft-ipc-worker 等 Pathcraft 專用命名改成 Pedelec 中性的命名（例如 pedelec-ipc-worker）；環境變數、__PATHCRAFT_BUNDLE__、PATHCRAFT_RUST_WORKER_BIN、rust/target 路徑 fallback、SDK 內部 Pathcraft Host 語意都需移除／改為中性受信任設定。改名不能破壞 protocol/CLI ACK 契約。
6. Git History 全新，來源與 Attribution 在 README/NOTICE 記錄，勿複製任何 Provider Auth、node_modules、target、artifacts、.env、Workspace SQLite、test secrets 或私有日誌。
7. 所有 source／build scripts／tests 在新 Repo 以相對自身路徑運作；不得依賴 Pathcraft Desktop TS paths、Root npm workspace、Tauri 或本機固定路徑。

## 3. Single npm Package 組織與公開入口

- package.json 使用 **name: @kaoruisaac/pedelec-node**、**private: false**、type: module；初版可從 0.1.0 運用 SemVer 起版，版本／tag／Native manifest 完整一致，不能沿用舊 private package 發版身分。
- npm pack 內容須包含 production ESM JavaScript（不是 ts source runtime import）、.d.ts、Native binary、manifest、LICENSE／third-party notices、必要 README；source maps 可評估但不得包含機密路徑或 token。
- 正式 exports 僅公開 package root 及明確審核過的 API entry；勿保留 private transport deep import 作長期承諾。Consumer 不依賴 node_modules package 內部路徑。
- Rust IPC Worker、pedelec-agent、pedelec-cli **由 SDK 自行定位、啟動、關閉**；Pedelec Host Tool CLI 需透過 SDK 受信任的 Provider child process PATH/command injection 可見，不要求使用者自行放系統 PATH。
- 本套件包含 Runtime native executable，**不內含** Codex、Claude、OpenCode、Cursor、Antigravity 的 Provider CLI／認證；缺 CLI／認證的錯誤要明確又不洩密。
- 不使用 postinstall 從任意網址抓二進位、不在終端使用者的安裝期編 Rust；三個目標平台的 binary 放進**同一個跨平台 tarball**，每平台至少 Worker/Agent/CLI 三支 executable；不另出平台 npm package。
- package bin CLI 是否對外暴露選用：若提供 pedelec-cli 執行入口，須明確限制為 SDK 管理 Session 的 Host Tool 通道，防止被誤用成 unrestricted execution API。

## 4. Native bundle 檔案與 platform dispatch

~~~text
bin/
  darwin-arm64/
    pedelec-ipc-worker
    pedelec-agent
    pedelec-cli
  win32-x64/
    pedelec-ipc-worker.exe
    pedelec-agent.exe
    pedelec-cli.exe
  linux-x64-gnu/
    pedelec-ipc-worker
    pedelec-agent
    pedelec-cli
  manifest.json
dist/
  index.js
  index.d.ts
~~~

- manifest 至少含 packageVersion、protocolVersion、各 target triple/platform/arch、binary name、SHA-256、檔案大小及必要依賴／build version；啟動前校驗存在、版本一致與 manifest integrity，缺檔／不支援平台時 fail-closed 並回可讀 error。
- Runtime 路徑由 import.meta.url 或正式 package 入口解析；根據 process.platform/arch 及 Linux libc 條件選取確切 bundle；**不能** fallback 到 Pathcraft rust/target、其他 repo build cache 或未驗證 PATH。
- macOS/Linux 保留 executable mode；Windows .exe、長路徑/空白、子程序群組終止、SIGINT/SIGTERM、Worker crash／restart policy、Provider process cleanup 全需測試。
- Linux 初版只承諾 x64 glibc，驗證 Debian/Ubuntu-based Node Docker（例如 node:24-bookworm-slim），**不宣稱 Alpine/musl**。需檢查 glibc 最低版本、動態連結（ldd/readelf）、執行權限與非 root 的 runtimeStorageRoot 寫入權限。
- Docker consumer 即使在無圖形／Tauri 環境，也應可打開 Worker、呼叫有配置的 Provider、發出 Tool Trace、執行 Host Tool、cancel/close、收斂 Process Tree。證據不足時該 Provider 測項標 NOT RUN 而非 PASS。
- 預期整包會包含三平台資產；測試 npm pack 大小和 registry 上限、二進位分發合法性，若超標屬 Release Blocker，不得暗中更改為多 npm package。

## 5. CI／版本／開源發布

1. GitHub Actions 分別在 macOS arm64 runner（或可驗證 macOS arm64 build target）、Windows x64、Linux x64 glibc 建置 Native；每個平台自測 Rust tests / binary --version 或正式 self-check，輸出含 checksum 的 artifacts。
2. Release assemble job 只從**同一 commit／tag** 採集平台 artifacts，生成一份 manifest，build TypeScript，執行 npm pack --dry-run、npm pack、tarball 檔案清單／checksum／licensing 檢查。
3. CI smoke 安裝**產出的 tarball**於 3 平台的乾淨、與 Pathcraft 無關的 Consumer；不能只在 monorepo workspace test 跑過就放行。
4. Node.js ESM、TypeScript declarations、Node 最低支援版本與 Bun（若宣稱）必須明示。原 SDK engines 為 Node >=24.22.1 <25；改動最低版需 API／native 真驗證。Pathcraft 使用 Bun 時還需另做其 bundle/runtime smoke。
5. Public Repo 包含 MIT 或經核對可相容的明確 License、third-party notices；執行 Secrets Scanner、dependency/license audit、Cargo/npm lockfile、SBOM（建議）、供應鏈審閱；未確認再散布權的 binary 不可 publish。
6. 按 SemVer 鎖定單一 JS+Native+Protocol 版本；有 Breaking API／Protocol 才 bump major；Release notes 註明各平台與 Provider Coverage Matrix、Ollama backlog、Linux glibc 限制。
7. 發布流程：Repo 建 Public → 首版 Branch/CI Gate → Git tag／GitHub Release → npm publish --access public → npm view 驗證版本／tarball hash → 乾淨外部再安裝驗證。**公開授權已取得，但 CI Gate FAIL 不得硬發布**。
8. npm scope 權限、GitHub repo token 與 CI publish credential 由受信任維護者設定，不把 token 寫進 MD、CI logs 或 repo。若自動發布不可用，改走經審核的本機受信任 publish，保留可驗證紀錄；不可宣稱已發布。

## 6. Pathcraft Desktop 改為真正 npm Consumer

- 在新 package 獨立 Consumer Smoke PASS 且有可安裝版本後，修改 Pathcraft package.json / lockfile：由 private @pathcraft/pedelec-node workspace 改成精確釘住 @kaoruisaac/pedelec-node 版本；所有 server/app/agent 引用只走正式 exports。
- Server build（目前 esbuild bundle SDK 原碼）、Tauri desktop build/dev staging、Bun server / self-hosted 啟動改成使用 npm package。Native資產尋址、ESM external/bundle 策略需在 **tauri dev** 與 **tauri build 安裝版** 皆驗證。
- SDK Worker 與 Pedelec CLI 路徑改由 package 解析／管理；不能再從 Pathcraft rust/target、PATHCRAFT_RUST_WORKER_BIN 或原位 sources 複製。Pathcraft 專屬 Browser/Chrome 仍是 Host 自己的資產。
- Pathcraft SDK 呼叫保持既有 Session Port、Tool Manifest、Owner/ACL、Monitor、Debug Send Text、Graph/Run、Artifact/Provider State 與 Storage GC 語意；本階段才把 onAgentToolEvent **以 Host Adapter 訂閱接線**供 Pathcraft 觀察，但不在 SDK 建 Trace DB，也不擅自擴大業務 UI。
- **無需在此新增永久資料庫 Schema**：若 Host 需要持久 Solver Trace，另立 Host requirements；本次確保 Event 可由 Host 接到並以現有安全 Monitor／觀測流程做 smoke。
- 先改 consumer imports/build pipeline，再跑 SDK/Server/Desktop 所需回歸；確定沒有任何 Host 還依賴原私有路徑後，才以可審查 diff 刪除舊 packages/pedelec-node 及已遷移的重複 Rust crates／build copy scripts。
- 不能誤刪 Pathcraft 仍需要的 Tauri Rust host code、Managed Browser、Server Owner/ACL、其他人的未提交原始碼；需對照 git status，逐路徑確認，保留歷史 diff。**不留兩份長期並行維護的 SDK**。
- 最後檢查在 Pathcraft Repo 全域無原私有 package path、source import、rust/target runtime fallback、Pathcraft 命名的 SDK 環境變數，若剩餘為 legacy migration tool，須有理由及期限並列 blocker。

## 7. Coding 作業順序與依賴

- **A — 先決條件：** MD01 確認可用並有 Code Diff + Coverage；檢查當前 Git status、三平台測試條件與 GitHub/npm scope 權限。新獨立目錄內 docs 保留，不覆蓋。
- **B — 新 Repo Source：** init main、全新 Git History、公有 Repo；複製與解耦 SDK / Worker / agent / cli / Cargo workspace、更新包名及中性化 runtime 路徑；獨立 tests／typecheck。
- **C — Build + Pack：** 多平台 Native CI、package ESM/.d.ts、Manifest SHA、單 tarball npm pack、缺 Binary／版本錯配安全錯誤。
- **D — 3 平台 Consumer：** macOS arm64、Windows x64、Linux x64 CI + Linux Docker 的全新 Consumer 安裝、Provider/Host Tool、trace、cancel/close、native shutdown；Linux x64 Container 是必過，不列 Backlog。
- **E — Public Release：** License/Secrets Gate、CI Gate、tag/npm public publish、公開版重裝 smoke、GitHub README 使用範例／Migration Guide。
- **F — Pathcraft Migration：** 釘 npm 版本、調 build/tauri/dev/server、Consumer API／Monitor Adapter、三平台回歸；確認後才刪舊 SDK／重複 native sources。
- **G — Closeout：** 交一份檔案變更／commit／tag、npm/GitHub 連結、hash、Provider Coverage、各 OS QA、殘留 TBD 報告；只有最後一次 Human Review，Agent 應自行修到可交付。

## 8. Acceptance / Release Gate

- [ ] 新 Repo 全新 Git history、Public GitHub、獨立 source 根；完全沒有 Pathcraft 原始碼路徑／Host 業務 import、Build 不需 Pathcraft 工作樹。
- [ ] 單一 Public npm artifact，包含 JS/.d.ts、三平台（Mac ARM、Win x64、Linux x64 GNU）各三支 native executable、manifest/sha、License/third-party notices。
- [ ] npm install 乾淨 consumer → createSession → Native Tool Trace → CLI onTool → cancel/close → process cleanup，在 macOS、Windows、Linux Docker 各有真證據。
- [ ] 不支援平台、缺 binary、Manifest mismatch、Provider CLI absent、非法 symlink／路徑空白、untrusted override 有明確失敗；**不得 fallback 源樹舊 Worker**。
- [ ] macOS/Windows spawn、Tauri install、Linux non-root Docker/SIGTERM/linked libs、Node ESM 與 Pathcraft Bun 最小 smoke；未跑即 NOT RUN，不可寫 PASS。
- [ ] Public npm registry 和 GitHub Release 上版本一致，公開包可重新安裝、核對 hash、說明三平台與 Provider Coverage 及 Ollama backlog。
- [ ] Pathcraft 不再引入 @pathcraft/pedelec-node 或 src/transport 私有 import；build:server、tauri dev/build、Session/Host Tool、Debug/Monitor、Storage/GC、Agent/Provider 最小回歸 PASS。
- [ ] 完成後確實清掉 Pathcraft 重複 SDK/Native Build code，保留 Host business / Tauri code 和全部事前未提交變更；無第二套長期實作。
- [ ] 無外部 consumer PASS 不可標獨立完成；Linux Docker 或 Windows 真驗證缺失時不得宣稱三平台 Release Ready。

## 9. 已知 TBD / 後續 Backlog

- 已確認 Ollama／pedelec-agent Native Trace 改動屬 [BACKLOG.md](../BACKLOG.md) PN-B001，本次不要求其 FULL；不能以此阻止其它 Provider 的誠實 Coverage。
- Alpine/musl、macOS x64、Linux arm64、Windows arm64、SDK durable trace storage、跨 Session Listener 等未納入首發。
- Publish credential、第三方再散布授權、macOS Code Signing / Notarization 是否必要、三平台 CI Runner 可用性屬執行時 Gate；若無法解決須列 BLOCKER，不得假裝已完成。
- Pathcraft Desktop 具備未提交原始碼，實作前差異可能改變；須再核對來源與業務邊界，禁止直接整棵刪舊 Rust Workspace。
