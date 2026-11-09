# Migrating from the private `@pathcraft/pedelec-node` workspace package

| Before (Pathcraft monorepo) | After (`@kaoruisaac/pedelec-node`) |
| --- | --- |
| `"@pathcraft/pedelec-node": "0.1.0"` npm workspace, exports TS source | `"@kaoruisaac/pedelec-node": "0.1.0"` (exact pin), ESM JS + `.d.ts` |
| `import … from '@pathcraft/pedelec-node'` | `import … from '@kaoruisaac/pedelec-node'` (root entry only) |
| `@pathcraft/pedelec-node/transport/rust-ipc-supervisor` deep import | not exported; use the public API (`probeRustIpcWorker`, `nativeRuntimeInfo`) |
| Worker binary `pathcraft-ipc-worker` from `rust/target/<profile>`, `__PATHCRAFT_BUNDLE__` `assets/bin`, or `PATHCRAFT_RUST_WORKER_BIN` | `pedelec-ipc-worker` resolved from the package's `bin/<target>/`, manifest-verified; optional explicit `rustIpc.binaryPath` (absolute) |
| `PATHCRAFT_{CODEX,CLAUDE,OPENCODE,CURSOR,ANTIGRAVITY}_PATH` | `PEDELEC_{CODEX,CLAUDE,OPENCODE,CURSOR,ANTIGRAVITY}_PATH` |
| `PATHCRAFT_OLLAMA_BASE_URL`, `PATHCRAFT_AGENT_SESSION_ROOT`, `PATHCRAFT_MONITOR_DETAILS`, `PATHCRAFT_CURSOR_FAST` | `PEDELEC_OLLAMA_BASE_URL`, `PEDELEC_AGENT_SESSION_ROOT`, `PEDELEC_MONITOR_DETAILS` (set by the SDK from `detailedMonitoring`), `PEDELEC_CURSOR_FAST` |
| SDK refused a `runtimeStorageRoot` under `.pathcraft/{artifacts,provider-state,skills,deletions}` | Host-specific guard removed from the generic SDK; a Host that needs it keeps the check in its own adapter before calling `createSession` |
| Build scripts copied three binaries from `rust/target` | Nothing to copy for Node hosts. Bundlers must keep the package **external** (it locates `bin/` relative to its own `dist/`); a Host that bundles must ship `node_modules/@kaoruisaac/pedelec-node` intact |

Session API, Host Tool / `pedelec-cli` semantics, `onAgentToolEvent`, storage layout below `runtimeStorageRoot`, ended
handle retention (50) and fail-closed / no-retry behaviour are unchanged.
