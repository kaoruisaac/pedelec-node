import { EventEmitter } from 'node:events';
import type { SpawnOptions, ChildProcess } from 'node:child_process';

export declare function defaultWorkerPath(): string;
export declare const IPC_VERSION: 1;
export declare const MAX_IPC_FRAME_BYTES: number;
export declare const PROVIDER_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export declare class RustIpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  constructor(code: string, message: string, options?: { retryable?: boolean; requestId?: string });
}

export type RustIpcReply = Readonly<{ requestId: string; data: unknown }>;
export type RustIpcRequestOptions = Readonly<{ timeoutMs?: number }>;
export type RustIpcOpInput = Readonly<{ requestId?: string; sessionId?: string } & Record<string, unknown>>;
export type RustIpcEvent = Readonly<{ sessionId: string; sequence: number; kind: string; data: unknown }>;
export type RustIpcExitEvidence = Readonly<{
  pid: number | undefined; code: number | null; signal: string | null; expected: boolean; stderrBytes: number; at: string;
}>;

export type RustIpcStartOptions = Readonly<{
  binaryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  startTimeoutMs?: number;
  maxFrameBytes?: number;
  detailedMonitoring?: boolean;
}>;

export declare class RustIpcSupervisor extends EventEmitter {
  static start(options?: RustIpcStartOptions): Promise<RustIpcSupervisor>;
  readonly pid: number | undefined;
  readonly closed: boolean;
  request(input: RustIpcOpInput & { op: string; payload: unknown }, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  openSession(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  rehydrateSession(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  send(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  cancel(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  closeSession(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  resumeProvider(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  toolReply(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  providerArtifactHook(input: RustIpcOpInput, options?: RustIpcRequestOptions): Promise<RustIpcReply>;
  shutdown(options?: Readonly<{ graceMs?: number; timeoutMs?: number }>): Promise<RustIpcExitEvidence | undefined>;
  terminate(options?: Readonly<{ signal?: NodeJS.Signals; graceMs?: number }>): Promise<RustIpcExitEvidence | undefined>;
}
