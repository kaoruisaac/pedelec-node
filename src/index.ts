/**
 * @kaoruisaac/pedelec-node — Node/TypeScript SDK for the Pedelec Rust agent runtime.
 * Consumers use runtime/session objects only; the Rust IPC worker, request ids and NDJSON frames stay inside this package.
 */
export { createPedelecRuntime, PedelecNodeClient } from './client.ts';
export type { CreateSessionInput, PedelecRuntimeOptions } from './client.ts';
export type { PedelecNodeSession } from './session.ts';
export { AGENT_TOOL_TRACE_LIMITS } from './agent-tool-trace.ts';
export { defineTool } from './tools.ts';
export { PedelecError } from './errors.ts';
export type { PedelecErrorCode } from './errors.ts';
export { probeProviders, probeRustIpcWorker } from './transport/rust-ipc.ts';
export { nativeRuntimeInfo } from './native-info.ts';
export type { NativeRuntimeInfo } from './native-info.ts';
export type { PedelecProviderScan, PedelecTransport, PedelecTransportConnection } from './transport/rust-ipc.ts';
export type * from './types.ts';
