# P04 — Ollama / Pedelec Agent handoff (Agent D)

> **2026-11-05 Superseded by MD18:** this crate again carries upstream's native tools (`fs.*`, `web.search`, restricted `bash`) and no longer has a Host tool transport. Session storage comes from `PEDELEC_AGENT_SESSION_ROOT` (Server-owned) or upstream's `~/.pedelec/agent`, never the Task workdir. The text below records the earlier P04 state.

2026-11-04, macOS Darwin arm64, repository HEAD `b68c70c3a8d96eb9be194314069ad317da7cb54d` plus existing uncommitted work.

**Local implementation / fake-service verification is complete. Overall Runtime Gate A and Tool Gate B remain NOT RUN / false pending real Ollama and release integration. This is not a Desktop PASS.** Shared manifests, provider routing, SDK admission and build scripts were deliberately not edited. Agent F must integrate the changes below before the new provider participates in the production worker.

## Owned changes and dependency inventory

- `../pedelec-ipc-worker/src/providers/pedelec_agent.rs`: private Ollama open/attach/send/event/Host reply/cancel/close dispatcher. Uses `PedelecAgentServerController`, trusted executable discovery beside the Worker, no PATH or IPC executable override. Default effort only. Model/workspace/session identity is checked by original Controller/store. No Provider/model fallback.
- This crate: migrated upstream Agent serve, Ollama backend, conversation, persistence and lifecycle. The binary entry remains the original `pedelec_agent::run()`.
- `integration/controller.patch`, `routing.patch`: exact shared-code additions for F; applied and tested only in an isolated workspace. `controller-methods.rs` is the readable insertion source.
- `integration/ollama-sdk.test.ts`: fake HTTP Ollama + actual Agent/Worker/Node SDK, not a fake Agent binary.
- `integration/validate.py`: copies Rust/SDK into a new temporary directory, applies integration patches, changes SDK admission only in that copy, runs tests and build with logs/exit codes. Requires the pinned Bun in the installed repository node_modules, Python 3, Cargo cached dependencies (`--offline`), `patch`. `ps` cleanup/crash tests are POSIX-only and explicitly skipped on Windows.

Original direct dependencies: `base64`, `chrono`, `reqwest` (blocking JSON/rustls), `serde`, `serde_json`, `uuid`, `pedelec-shared`; dev `tempfile`. No direct Core crate dependency. Original `tools.rs` invoked `pedelec-cli` (Core RPC), a separate script-runtime helper and filesystem tools; `tavily.rs` called an external web service. The helper and its config fields are removed; `bash` only runs `pedelec-cli`. No Sandbox file reader/listing, general shell, Core runtime file, Graph/DB authority, Tavily credential/service, MCP executable, or model download is required by this binary.

Added direct dependency: workspace `jsonschema` (default features disabled by existing workspace) for dynamic Host schemas and model args. `pedelec-shared` supplies original URL validation, error and home-directory/settings helpers; this transitively compiles its existing shared dependencies, but **Agent does not depend on `pedelec-core` or `pedelec-runtime`**. No new Cargo workspace dependency versions are needed.

Original Pedelec settings parsing is preserved (`providerSettings.ollama.baseUrl/timeoutMs`). A trusted Server environment override `PEDELEC_OLLAMA_BASE_URL` uses the same URL validator. `OLLAMA_API_KEY` is used when supplied; local unset key defaults to `ollama`. Under the Pathcraft Worker, the SDK assigns one Ollama store per SDK Session via `PEDELEC_AGENT_SESSION_ROOT` (`<root>/sessions/YYYY/MM/<providerSessionId>/`). The Worker requires the store, and the Agent independently holds the SDK writer leases for its lifetime. No prompt/model/tool argument can change executable discovery or that store path.

## Source map / reasons for differences

All source paths below are relative to `migration/upstream/pedelec/desktop/crates/pedelec-agent/src/` and map to the same relative path here.

| Source | Migration |
| --- | --- |
| `main.rs`, `lib.rs`, `agent/mod.rs` | Original serve entry/exports; removed legacy ToolHost exports, added Host transport module. |
| `agent/ollama.rs`, `backend.rs` | Original `/api/show`, `/api/chat`, NDJSON parser, tools/vision probe, inference mapping; only test config fields trimmed. |
| `agent/conversation.rs`, `store.rs`, `lifecycle.rs`, `error.rs` | Original conversation/committed-turn schema, precise resume identity and lifecycle/commit checks retained. |
| `agent/session.rs` | Original inference/tool-round/commit flow. Host snapshot replaces built-in tools; validate args, wait for Host result, then continue inference. Tool-free models permitted. Removed obsolete built-in execution tests/hooks. |
| `agent/server/{mod,protocol,registry,cli}.rs` | Original JSON-RPC server, session registry, turn admission and events. Added `session/tools` and `turn/tool_reply`, bounded 1 MiB ingress and sequential control dispatch (turn inference still runs in original worker thread). Tool transport preserves complete payloads; telemetry redaction occurs at Worker EventSink. |
| `agent/server/registry.rs` | Fixed original concurrent Drop cleanup race: release owned lock Arc under registry mutex, so final Drop sees the current reference count. Existing mutual-exclusion regression exposed the leak. |
| `agent/config.rs`, `sandbox.rs`, `instructions.rs`, `tools.rs` | Retained settings/workspace identity/DTO portions only. Removed file execution and old helper-specific prompt/config. HostInstructions are model system instructions. |
| `agent/tavily.rs`, `agent/server/tests.rs` | Not migrated: removed external service and old built-in-tool server fixtures. Original Ollama parser/store/lifecycle/registry tests retained; new end-to-end tests replace the removed incompatible tests. |

Dispatcher reference: upstream `pedelec-ipc/src/pedelec_agent.rs` session creation/turn/event/shutdown behavior; no SharedCoreRuntime, old IPC server, ToolRequestBroker, business reducer or registry is imported.

## Tool wire contract and failure behavior

1. Existing Controller `ensure_session` performs `session/open` and capability probe. Non-tools models are allowed only with an empty descriptor snapshot.
2. `configure_host_tools(thread, session, descriptors)` sends `session/tools`, requiring `{configured:true}`. Zero through 64 generic tools are accepted, schema is validated, snapshot is immutable even when empty.
3. Original session inference sends only that snapshot to Ollama. Calls must name a registered descriptor and pass its JSON schema. A call is registered before emitting `turn/tool_call` so a fast Host reply cannot race registration.
4. Worker maps the notification to SDK `tool-request` (`turnId`, `toolCallId`, `toolName`, `args`). SDK scope/session validation and handler remain authoritative. Multiple calls are consumed sequentially with the existing SDK ACK flow.
5. SDK handler result goes through Worker `tool-reply`, Controller `turn/tool_reply` and Agent correlated pending channel. Only an affirmative Agent response yields SDK `{acknowledged:true,turnId,toolCallId}`. Original inference continues with the Host result in its conversation.
6. Duplicate call IDs, unregistered tools, invalid args, timeout, crash and failed/missing ACK never trigger automatic replay. Tool wait timeout is fixed at 60 seconds; no per-tool timeout API was added. Cancellation retires the Agent process and reports `CANCEL_OUTCOME_UNKNOWN`; it does not assert rollback. SDK remains outcome-unknown. Close, EOF/shutdown cleanup and Drop shut down/join the process/pump. Provider stderr and raw RPC payloads never enter provider-rpc telemetry.

The ACK confirms transport consumption; SDK remains the authority for handler effects, turn completion and unknown outcomes. Agent conversation persistence is not a second Pathcraft business state machine.

## Exact integration instructions for Agent F

1. `rust/Cargo.toml`: add `"crates/pedelec-agent",` to `workspace.members`; existing workspace dependencies already supply all dependencies. Regenerate Cargo.lock normally.
2. `rust/crates/pedelec-ipc-worker/Cargo.toml`: add `jsonschema.workspace = true` under dependencies.
3. From repository root, review/apply `git apply rust/crates/pedelec-agent/integration/controller.patch` and `git apply rust/crates/pedelec-agent/integration/routing.patch`. Merge the routing arms with other Provider agents rather than replacing their module. Controller changes add only scoped `session/tools`/`turn/tool_reply` request methods and permit `modelCapabilities.tools=false`; the existing parser test is corrected accordingly. No Controller transport internals or existing DTO fields are replaced.
4. `package.json` `build:rust` must become exactly `cargo build --release -p pedelec-ipc-worker -p pedelec-agent --manifest-path rust/Cargo.toml`.
5. `scripts/build-server.mjs`, replace the current one-Worker copy block (around lines 62–67) with:

```js
mkdirSync(join(assets, 'bin'), { recursive: true });
for (const name of ['pedelec-ipc-worker', 'pedelec-agent']) {
  const binary = join(repo, 'rust', 'target', 'release', `${name}${ext}`);
  if (!existsSync(binary)) fail(`RUST_BINARY_MISSING ${name}: run npm run build:rust first`);
  const staged = join(assets, 'bin', `${name}${ext}`);
  copyFileSync(binary, staged);
  if (process.platform !== 'win32') chmodSync(staged, 0o755);
}
```

   In its cargo license `tree` command add `'-p', 'pedelec-agent'` beside the Worker selection and add `'pedelec-agent'` to the own-crate exclusion Set. Add `pedelecAgent: \`dist-server/assets/bin/pedelec-agent${ext}\`` to manifest next to `rustWorker`. Existing asset walk will hash both binaries; ensure both entries exist, architecture matches manifest platform/arch and missing Agent fails packaging.
6. `scripts/tauri.mjs` already runs `build:rust`, `build` and stages the whole app tree. Add `'app/dist-server/assets/bin/pedelec-agent'` to the macOS post-build required-file list near line 168. Windows staging uses `.exe`; assert `app/dist-server/assets/bin/pedelec-agent.exe` in the equivalent installed-resource check. No manual binary copies outside build scripts.
7. `scripts/build-desktop.mjs` already copies all `dist-server` resources; before creating the platform manifest, require `join(app,'dist-server/assets/bin',\`pedelec-agent${exe}\`)` to exist and include `pedelecAgent: serverManifest.pedelecAgent` in `serverCore`. `files` enumerates the asset automatically. Headless Server ships the same `dist-server/assets/bin` pair.
8. No `scripts/*doctor*` or platform staging script exists in this checkout. The actual doctor is `server/app/cli.ts:169`: its `verifyInstalledAssets()` already checks enumerated manifest hashes, while `checks.rustWorker` probes the Worker. Add `checks.pedelecAgent` there to require the same-platform sibling Agent and executable permission; keep architecture checks in platform packaging, and keep missing/modified Agent fatal through `verifyInstalledAssets()`. Never compile/download at application launch.
9. macOS: native build per architecture; retain `0755`, verify `file` and `otool -L`, include Agent in nested executable signing/notarization when that release workflow is used. Windows: build native MSVC target, stage both `.exe` files, inspect PE target/imports and installer resource paths, test process-tree cleanup on the Windows runtime. The only helper this crate spawns is `pedelec-cli`. Bundling Ollama itself or any model is not required or implemented.
10. (Superseded 2026-11-05 by MD19 §10: Ollama Host Tools are wired through the restricted bash and `pedelec-cli`, IMPLEMENTED / UNVERIFIED.) P06/F owns SDK/Server admission. Production `packages/pedelec-node/src/client.ts` was Codex-only at the time. Do not infer Gate B from `modelCapabilities.tools`; keep tool-required Ollama roles disabled until real service/model and release evidence pass. For isolated transport verification only, `validate.py` adds Ollama in a copied SDK. No production allowlist changes are included.
11. Append the results below to shared `implementation/remaining/reports/13-provider-integration.md`; Agent D kept this report inside its owned crate to avoid concurrent edits to the shared report.

## Acceptance / outstanding verification

See `P04_RESULTS.md` for actual commands, exit codes, evidence and remaining gates. After integration F must run both crate tests plus `npm run build:rust`, `npm run build`, `npm run tauri build`, SDK/Server/Run/Monitor negatives and native installed macOS/Windows smoke tests. A binary built in the isolated folder is not a release asset or Desktop validation.
