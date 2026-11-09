# @kaoruisaac/pedelec-node

Node.js / TypeScript SDK for the **Pedelec agent runtime**. One npm package contains the SDK *and* the native runtime
(`pedelec-ipc-worker`, `pedelec-agent`, `pedelec-cli`) for every supported platform. No postinstall download, no Rust
toolchain on the consumer machine, no platform sub-packages.

The SDK drives local coding-agent CLIs (Codex, Claude Code, OpenCode, Cursor Agent, Antigravity; Ollama through the
bundled `pedelec-agent`), exposes Host-defined tools to the agent through `pedelec-cli`, and streams a Level 1
**Agent Tool Trace**: every tool call the agent itself makes (native Shell / file / search tools and Host tools).

| Platform | Native bundle | Status |
| --- | --- | --- |
| macOS arm64 | `bin/darwin-arm64` | supported |
| Windows x64 | `bin/win32-x64` | supported |
| Linux x64, glibc (Debian / Ubuntu, e.g. `node:24-bookworm-slim`) | `bin/linux-x64-gnu` | supported |
| Alpine / musl, macOS x64, Linux arm64, Windows arm64 | — | **not supported** (fails closed with `NATIVE_UNSUPPORTED_PLATFORM`) |

Runtime: **Node.js `>=24.22.1 <25`**, ESM only. The package does **not** include any Provider CLI or credential: install
and sign in to the Provider you want (`codex`, `claude`, `opencode`, `cursor-agent`, `agy`) yourself.

## Install

```bash
npm install @kaoruisaac/pedelec-node
```

## Maintainer: bump SDK + Rust version

```bash
npm run version 0.0.1
```

Updates `package.json`, `package-lock.json`, `rust/Cargo.toml` (`workspace.package.version`) and the six local crate entries in `rust/Cargo.lock` together. Requires an explicit SemVer; does not commit, tag or publish. **Native binaries and `bin/manifest.json` are intentionally not changed**: after bumping, rebuild and restage all three native targets, regenerate `bin/manifest.json` and pass release verification before publishing. Git/Release/npm publishing is controlled from Windows (Syncthing links the Mac mini development workspace).

## Quick start

```ts
import { createPedelecRuntime, defineTool, nativeRuntimeInfo } from '@kaoruisaac/pedelec-node';

console.log(nativeRuntimeInfo()); // { target: 'darwin-arm64', version: '0.1.0', ... } — verifies the bundled binaries

const echo = defineTool({
  name: 'echo',
  description: 'Echo text back to the agent.',
  argsSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
});

const runtime = await createPedelecRuntime();
const session = await runtime.createSession({
  provider: 'codex',               // 'codex' | 'claude' | 'opencode' | 'cursor' | 'antigravity' | 'ollama'
  model: 'gpt-5.5',
  effort: 'medium',
  workdir: '/absolute/path/to/project',
  runtimeStorageRoot: '/absolute/path/to/project/.pedelec-runtime', // SDK-private storage, chosen by the Host
  tools: [echo],
});

session.onTool('echo', (args) => ({ success: true, result: { echoed: args.text } }));
session.onAgentToolEvent((event) => {
  // { source: 'provider-native' | 'pedelec-host', kind: 'started' | 'updated' | 'finished' | 'observation-gap',
  //   toolName, toolKind, status, exitCode?, input?, output?, toolCallId, ... }
  console.log(event.source, event.toolName, event.kind, event.status ?? '');
});
session.onChatDelta((text) => process.stdout.write(text));
session.onTurnEnded((outcome) => console.log('\nturn:', outcome.terminal));

await session.sendText('List the files here, then call the echo tool with "hi".');
// ... later
await session.close('done');
await runtime.close();
```

### Main API

| API | Purpose |
| --- | --- |
| `createPedelecRuntime(options?)` | Verifies this platform's native bundle and returns a client. Each active session runs its own worker process. |
| `client.createSession(input)` / `client.resumeSession(sessionId)` | Open a Provider session / get a handle still held in RAM (the newest 50 ended handles are kept). No cross-restart resume. |
| `session.sendText(text, { turnId? })` | Start one turn. |
| `session.onTool(name, handler)` | Host Tool handler, reached by the agent through `pedelec-cli` (the SDK injects it into the Provider's PATH). |
| `session.onAgentToolEvent(listener)` | Read-only Level 1 trace of the agent's real tool calls. Never changes execution. |
| `session.onChat` / `onChatDelta` / `onArtifact` / `onTurnEnded` / `onError` | Conversation, artifacts and turn outcome. |
| `session.cancel(reason)` / `session.close(reason)` / `client.close()` | Cancel the active turn / end the session / stop every worker. |
| `client.onMonitorEvent(listener)` | Metadata-only runtime monitor (opt-in `detailedMonitoring` adds bounded IPC frames for trusted debugging). |
| `probeProviders()` | Which Provider CLIs this machine has. |
| `nativeRuntimeInfo()` | Verify the bundled native runtime without starting it. |

Failure semantics are fail-closed: an ambiguous Provider or Host Tool result becomes `outcome-unknown` and is **never
retried or replayed**.

### Trace data and security

The Tool Trace carries the Provider's own values (commands, arguments, output) with **truncation, not redaction**: it can
contain secrets, file paths and file contents your agent touched. Treat it as sensitive; persistence, access control and
retention are the Host's responsibility. The trace grants no OS permission and is not a sandbox.

`pedelec-cli` is only an SDK-session channel for Host Tools: it needs the session endpoint the SDK creates and is not a
general execution API.

## Native bundle integrity

`bin/manifest.json` records package version, IPC protocol version and the size and SHA-256 of every executable. Before
the first spawn the SDK checks them for the current platform. A missing, modified, symlinked or version-mismatched binary
rejects with `PedelecError('TRANSPORT_UNAVAILABLE')` and a `transportCode` of `NATIVE_BINARY_MISSING`,
`NATIVE_MANIFEST_MISMATCH`, `NATIVE_BINARY_INVALID`, `NATIVE_MANIFEST_MISSING` or `NATIVE_UNSUPPORTED_PLATFORM`.
There is no fallback to a Cargo `target/` directory, another checkout or `PATH`.

A Host that ships its own worker build may pass an absolute `rustIpc.binaryPath` (with `pedelec-cli` beside it).

## Provider overrides

The worker discovers Provider CLIs on the user's PATH. A trusted Host may pin one with an absolute path:
`PEDELEC_CODEX_PATH`, `PEDELEC_CLAUDE_PATH`, `PEDELEC_OPENCODE_PATH`, `PEDELEC_CURSOR_PATH`, `PEDELEC_ANTIGRAVITY_PATH`
(pass them through `createPedelecRuntime({ rustIpc: { env } })`). `PEDELEC_OLLAMA_BASE_URL` points `pedelec-agent` at an
Ollama server.

## Coverage and known limits

- Provider Tool Trace coverage is verified per Provider and OS; see the GitHub Release notes for the current matrix.
  A Provider without real-run evidence is reported as NOT RUN, not as supported.
- Ollama (`pedelec-agent`) native tool trace is backlog (PN-B001); its trace is partial.
- Large `hostInvocations` lists can make a single trace event exceed the nominal 64 KiB bound; very long JSON object keys
  are not truncated.
- Linux support is x64 glibc only.

## Building from source

```bash
npm ci
npm run build:rust:dev && npm run stage:native -- --profile debug   # bin/<host-target>/ + bin/manifest.json
npm run typecheck && npm run build && npm test && npm run test:rust
```

Releases are assembled by CI from one commit: each platform builds and tests its own binaries, one job merges them into
one manifest, packs one tarball, and installs that tarball into clean consumers on all three platforms (including a
non-root Debian Docker container) before publishing. See `.github/workflows/`.

## Origin

Extracted from the author's Pathcraft Desktop project (SDK, Rust IPC worker and runtime crates), with a fresh Git
history. This package has no dependency on Pathcraft. The older `kaoruisaac/pedelec` repository (browser extension /
desktop bridge) is a separate product.

## License

MIT © Isaac Lin. Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
