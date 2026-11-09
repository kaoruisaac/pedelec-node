# @kaoruisaac/pedelec-node 0.1.0

First standalone release. One npm package carries the Node/TypeScript SDK and the native runtime
(`pedelec-ipc-worker`, `pedelec-agent`, `pedelec-cli`) for **macOS arm64, Windows x64 and Linux x64 (glibc)**.

## Highlights

- `session.onAgentToolEvent(listener)`: read-only Level 1 Agent Tool Trace (Provider-native tool calls and Host tools
  reached through `pedelec-cli`). Values are kept as the Provider reported them, with truncation, no redaction.
- Native bundle is verified before first use (package version, IPC protocol, size, SHA-256); damaged or unsupported
  installs fail closed. No fallback to source-tree binaries, no postinstall download.
- `nativeRuntimeInfo()` to check an install without starting a worker.

## Release QA (this tag's CI run)

Every job below installs the **same packed tarball** into a clean consumer outside the source tree and runs
`consumer-smoke/smoke.mjs` (fake Codex App Server, real packaged worker and `pedelec-cli`): createSession → native Shell
trace → `pedelec-cli` → `onTool` → cancel → close → process cleanup, Host SIGTERM cleanup, absent Provider, and five
damaged-install cases. Reports are attached to this release.

| Platform | Native build + Rust tests | Clean consumer smoke | Notes |
| --- | --- | --- | --- |
| macOS arm64 | CI | CI | |
| Windows x64 | CI | CI | static MSVC CRT |
| Linux x64 glibc | CI | CI (Ubuntu runner) + Docker `node:24-bookworm-slim` and `ubuntu:24.04`, non-root, `docker stop` | glibc floor recorded in `glibc-floor.txt` |

## Provider Tool Trace coverage (real Provider runs)

| Provider | macOS arm64 | Windows x64 | Linux x64 |
| --- | --- | --- | --- |
| Codex | PASS (MD01/01A real E2E, 2026-11-09) | NOT RUN | NOT RUN |
| Claude Code | PASS (MD01/01A real E2E, 2026-11-09) | NOT RUN | NOT RUN |
| OpenCode | NOT RUN | NOT RUN | NOT RUN |
| Cursor Agent | NOT RUN | NOT RUN | NOT RUN |
| Antigravity | NOT RUN | NOT RUN | NOT RUN |
| Ollama (`pedelec-agent`) | backlog PN-B001 (partial trace) | backlog | backlog |

NOT RUN means no real-Provider evidence exists for that cell yet; the adapters are implemented and covered by fixture
tests, but no support claim is made.

## Known limits

- Linux: x64 glibc only (Debian/Ubuntu). Alpine/musl, macOS x64, Linux arm64 and Windows arm64 are not shipped.
- Large `hostInvocations` lists can push one trace event past the nominal 64 KiB bound; long JSON keys are not truncated.
- Binaries are not code-signed/notarized (npm installs are not quarantined by Gatekeeper).
