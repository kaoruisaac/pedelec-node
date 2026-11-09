import { execFile } from 'node:child_process';
import { defaultWorkerPath, RustIpcSupervisor, type RustIpcStartOptions } from './rust-ipc-supervisor.mjs';
import type { PedelecProvider } from '../types.ts';

/**
 * SDK-private transport seam. Production uses one Rust IPC v1 worker per session; tests may inject a fake connection
 * through `createPedelecRuntime({ transport })`. Server business code never sees this shape.
 */
export type TransportOpInput = Readonly<{ requestId: string; sessionId: string } & Record<string, unknown>>;
export type TransportReply = Readonly<{ data?: unknown }>;
export type TransportCallOptions = Readonly<{ timeoutMs?: number }>;
export type TransportEvent = Readonly<{ sessionId?: unknown; sequence?: unknown; kind?: unknown; data?: unknown }>;

export interface PedelecTransportConnection {
  readonly pid?: number;
  /** True once the Worker process has exited. A transport that cannot tell leaves it undefined. */
  readonly closed?: boolean;
  on(event: 'event', listener: (event: TransportEvent) => void): unknown;
  on(event: 'crash' | 'failure', listener: (detail: unknown) => void): unknown;
  /** Default metadata only; trusted detailedMonitoring opt-in may include the IPC frame. */
  on(event: 'monitor', listener: (record: Readonly<Record<string, unknown>>) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  openSession(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  rehydrateSession?(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  send(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  cancel(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  closeSession(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  toolReply(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  providerArtifactHook?(input: TransportOpInput, options?: TransportCallOptions): Promise<TransportReply>;
  shutdown(options?: Readonly<{ graceMs?: number; timeoutMs?: number }>): Promise<unknown>;
  terminate(options?: Readonly<{ graceMs?: number }>): Promise<unknown>;
}

export interface PedelecTransport {
  connect(privateEnv?: NodeJS.ProcessEnv): Promise<PedelecTransportConnection>;
}

export type RustIpcTransportOptions = Pick<RustIpcStartOptions, 'binaryPath' | 'cwd' | 'env' | 'startTimeoutMs' | 'detailedMonitoring'>;

/** Rust IPC v1 transport: spawns the packaged, manifest-verified `pedelec-ipc-worker` (or the Host's explicit `binaryPath`) per connection. */
export function rustIpcTransport(options: RustIpcTransportOptions = {}): PedelecTransport {
  return Object.freeze({
    connect: async (privateEnv?: NodeJS.ProcessEnv): Promise<PedelecTransportConnection> => RustIpcSupervisor.start({ ...options, env: { ...(options.env ?? process.env), ...privateEnv, PEDELEC_MONITOR_DETAILS: options.detailedMonitoring ? '1' : '0' } }),
  });
}

/** What this machine has installed, per the Worker's trusted Provider discovery. Host-local; `path` never leaves the Server. */
export type PedelecProviderScan = Readonly<Record<PedelecProvider, Readonly<{ available: boolean; path?: string; version?: string | null }>>>;

/** One bounded `--provider-scan`. Resolves null when the Worker cannot answer, so callers fail closed. */
export function probeProviders(options: Pick<RustIpcStartOptions, 'binaryPath' | 'env'> & Readonly<{ timeoutMs?: number }> = {}): Promise<PedelecProviderScan | null> {
  let binary: string;
  try { binary = options.binaryPath ?? defaultWorkerPath(); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    execFile(binary, ['--provider-scan'], { timeout: options.timeoutMs ?? 20_000, maxBuffer: 256 * 1024, windowsHide: true, env: options.env ?? process.env }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout) as PedelecProviderScan); } catch { resolve(null); }
    });
  });
}

/** Starts and cleanly stops one worker. Used by installed self-checks; returns the observed pid. */
export async function probeRustIpcWorker(options: RustIpcTransportOptions = {}): Promise<number | undefined> {
  const worker = await RustIpcSupervisor.start(options);
  const pid = worker.pid;
  await worker.shutdown({ graceMs: 500, timeoutMs: 3000 });
  return pid;
}
