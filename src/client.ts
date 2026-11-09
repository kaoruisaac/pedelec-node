import { sessionStorage, storageRoot, StorageKeeper } from './runtime-storage.ts';
import { ArtifactStore } from './artifacts.ts';
import { CliEndpoint, cliCommands } from './transport/cli-endpoint.ts';
import { resolveNativeBundle, validateExplicitWorker } from './transport/native-bundle.mjs';
import { dirname, join, delimiter } from 'node:path';
import { access } from 'node:fs/promises';
import { PROVIDER_CAPABILITIES } from './transport/rust-ipc-supervisor.mjs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PedelecError, transportCodeOf } from './errors.ts';
import { MonitorBus, type MonitorInput } from './monitor.ts';
import { PedelecNodeSession, isRecord, isSafeId, reactivateConnection, type SessionInit } from './session.ts';
import { parseCoverage } from './agent-tool-trace.ts';
import { normalizeTools } from './tools.ts';
import { rustIpcTransport, type PedelecTransport, type PedelecTransportConnection, type RustIpcTransportOptions } from './transport/rust-ipc.ts';
import type { PedelecMonitorEvent, PedelecProvider, PedelecSessionStatus, PedelecToolDescriptor, Unsubscribe } from './types.ts';

/** Only recoverable ended handles are retained in RAM; active Sessions are never count-limited. */
const MAX_RETAINED_ENDED_SESSIONS = 50;
/** Claude and Antigravity prepare for up to 90 s inside open-session. */
const OPEN_TIMEOUT_MS = 120_000;
/** The Worker's limit for Host text plus Tool guidance. */
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set<PedelecProvider>(['codex', 'claude', 'opencode', 'cursor', 'ollama', 'antigravity']);

export type PedelecRuntimeOptions = Readonly<{
  /** `rust-ipc` (default) spawns the bundled/dev Rust worker. A transport object is for isolated tests only. */
  transport?: 'rust-ipc' | PedelecTransport;
  rustIpc?: RustIpcTransportOptions;
  sendTimeoutMs?: number;
  toolReplyTimeoutMs?: number;
  /** Explicit, trusted Desktop-only opt-in. The default monitor remains metadata-only. */
  detailedMonitoring?: boolean;
}>;

export type CreateSessionInput = Readonly<{
  provider: string;
  model: string;
  effort: string;
  /** Absolute, Server-resolved workdir. The SDK never resolves client paths. */
  workdir: string;
  tools: readonly PedelecToolDescriptor[];
  /** Host-defined instructions; Rust never constructs application roles or Tool guidance. */
  hostInstructions?: string;
  /** Optional Server-reserved id (for example a pre-bound Run Agent session). Generated when omitted. */
  sessionId?: string;
  /** Trusted absolute technical storage root. The SDK chooses every path below it. */
  runtimeStorageRoot: string;
}>;

function validateText(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /[\u0000-\u001f]/.test(value)) {
    throw new PedelecError('INVALID_INPUT', `${name} is invalid`);
  }
}

/** Lists only this Session's Tools; argument schemas stay behind `tool-spec`. A session without Tools gets no guidance. */
function composeInstructions(host: string, sessionId: string, tools: readonly PedelecToolDescriptor[]): string {
  if (tools.length === 0) return host;
  return [
    host,
    'Use pedelec-cli in your shell to access the Host-defined tools listed below; read tool-spec before tool-call and follow its exact JSON schema. If none of those Host tools supports the operation you need, you may use your provider-native capabilities (such as shell, filesystem, or web tools) directly when available and permitted. Native capabilities do not require pedelec-cli, but must not be used to bypass a Host tool denial or failed/unknown outcome. Never fabricate a result. Run one Host tool command at a time; do not retry a failed/unknown Host tool result.',
    ...(process.platform === 'win32' ? [String.raw`Windows shell JSON quoting is version-specific. PowerShell 7+ (and POSIX sh/bash/zsh): pass raw JSON inside single quotes, e.g. '{"value":"x"}'; do NOT backslash-escape JSON double quotes. Windows PowerShell 5.1: pass JSON inside single quotes with each internal double quote backslash-escaped for the native executable, e.g. '{\"value\":\"x\"}'. Never use the PowerShell 5.1 form in PowerShell 7+. Select the form for the shell actually executing pedelec-cli.`] : []),
    ...tools.map((tool) => {
      const { readSpecCommand, callCommand } = cliCommands(sessionId, tool.name);
      return `${tool.name}: ${tool.description}\nRead: ${readSpecCommand}\nCall: ${callCommand}`;
    }),
  ].join('\n');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new PedelecError('INVALID_INPUT', 'timeouts must be positive integers');
  return value;
}

/** Owns the sessions (and their per-session workers) it created. */
export class PedelecNodeClient {
  private readonly transport: PedelecTransport;
  private readonly cliOnly: boolean;
  private readonly workerPath: string;
  private readonly sendTimeoutMs: number;
  private readonly toolReplyTimeoutMs: number;
  private readonly sessions = new Map<string, PedelecNodeSession>();
  private readonly reserved = new Set<string>();
  private readonly monitor = new MonitorBus();
  private readonly detailedMonitoring: boolean;
  /** Recoverable ended handles in confirmed-ended order. Every entry is also in `sessions`. */
  private readonly endedHandles = new Map<string, PedelecNodeSession>();
  /** A replaced handle may still be stopping its Worker; its successor waits before it contacts the Provider. */
  private readonly predecessors = new WeakMap<PedelecNodeSession, Promise<void>>();
  private readonly instanceId = randomUUID();
  private readonly roots = new Map<string, Promise<StorageKeeper>>();
  private readonly suspendedRoots = new Set<string>();
  private readonly evictions = new Map<Promise<void>, string>();
  private readonly opens = new Map<Promise<unknown>, string>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: PedelecRuntimeOptions = {}) {
    const transport = options.transport ?? 'rust-ipc';
    this.cliOnly = transport === 'rust-ipc';
    try {
      this.workerPath = options.rustIpc?.binaryPath === undefined ? resolveNativeBundle().worker : validateExplicitWorker(options.rustIpc.binaryPath);
    } catch (error) {
      throw new PedelecError('TRANSPORT_UNAVAILABLE', error instanceof Error ? error.message : 'native runtime unavailable', transportCodeOf(error), error);
    }
    this.detailedMonitoring = options.detailedMonitoring === true;
    if (transport === 'rust-ipc') this.transport = rustIpcTransport({ ...options.rustIpc, binaryPath: this.workerPath, detailedMonitoring: this.detailedMonitoring });
    else if (typeof transport === 'object' && transport !== null && typeof transport.connect === 'function') this.transport = transport;
    else throw new PedelecError('INVALID_INPUT', 'unsupported transport');
    this.sendTimeoutMs = positiveInteger(options.sendTimeoutMs, 30_000);
    // Longer than the 60 s Graph script limit, shorter than the CLI's 120 s read deadline.
    this.toolReplyTimeoutMs = positiveInteger(options.toolReplyTimeoutMs, 90_000);
  }

  /** Keeps the newest ended handles by confirmed end, skipping any handle that a resume currently owns. */
  private async retainEndedHandle(session: PedelecNodeSession): Promise<void> {
    if (this.sessions.get(session.sessionId) !== session || session.getStatus() !== 'ended') return;
    this.endedHandles.delete(session.sessionId);
    this.endedHandles.set(session.sessionId, session);
    for (const [id, handle] of this.endedHandles) {
      if (this.sessions.get(id) !== handle || handle.getStatus() !== 'ended' || !handle.mayReactivateAfterEnded()) this.endedHandles.delete(id);
    }
    while (this.endedHandles.size > MAX_RETAINED_ENDED_SESSIONS) {
      const oldest = [...this.endedHandles.values()].find((handle) => !handle.isResuming());
      if (!oldest) break;
      this.endedHandles.delete(oldest.sessionId);
      const eviction = this.collectEndedSession(oldest);
      this.evictions.set(eviction, oldest.runtimeStorageRoot);
      try { await eviction; }
      finally { this.evictions.delete(eviction); }
    }
  }

  private async collectEndedSession(session: PedelecNodeSession): Promise<void> {
    const id = session.sessionId;
    this.reserved.add(id);
    const retired = this.retireAndWait(session);
    const keeper = await this.roots.get(session.runtimeStorageRoot);
    try {
      await retired;
      if (!keeper) throw new Error('STORAGE_OWNERSHIP_LOST');
      const paths = sessionStorage(session.runtimeStorageRoot, this.instanceId, id, session.provider);
      await keeper.command({ action: 'collect', session: paths.segment, ollama: session.provider === 'ollama' });
    } catch (error) {
      // The instance marker survives partial removal. The next owner retries under its OS locks.
      keeper?.reportIncomplete(error);
    } finally {
      this.reserved.delete(id);
    }
  }

  /** A handle leaves the Runtime unless it is recoverable or still has an unresolved state a Host must see. */
  private released(session: PedelecNodeSession): void {
    const id = session.sessionId;
    if (this.sessions.get(id) !== session) return;
    if (!session.isRetired() && (session.getStatus() !== 'ended' || session.mayReactivateAfterEnded())) return;
    this.sessions.delete(id);
    if (this.endedHandles.get(id) === session) this.endedHandles.delete(id);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  getSession(sessionId: string): PedelecNodeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Every handle this Runtime holds, retained ended ones included: a technical RAM view with no Host meaning. */
  listSessions(): readonly PedelecNodeSession[] {
    return [...this.sessions.values()];
  }

  /**
   * The technical status of a handle held by this Runtime, or null. Purely a RAM read: it starts no Worker and contacts
   * no Provider. The answer is a snapshot; session.resume() and sendText() still enforce the state themselves.
   */
  async peekSessionStatus(sessionId: string): Promise<PedelecSessionStatus | null> {
    if (!isSafeId(sessionId)) throw new PedelecError('INVALID_INPUT', 'sessionId is invalid');
    return this.sessions.get(sessionId)?.getStatus() ?? null;
  }

  /** Read-only feed of every session this client owns. Listener failures are isolated; it can never change a session. */
  onMonitorEvent(listener: (event: PedelecMonitorEvent) => void): Unsubscribe {
    return this.monitor.add(listener);
  }

  async createSession(input: CreateSessionInput): Promise<PedelecNodeSession> {
    return this.trackOpen(isRecord(input) ? input.runtimeStorageRoot : undefined, () => this.open(input, null));
  }

  /**
   * Returns the handle this Runtime holds for the id, ended ones included; session.resume() then contacts the original
   * Provider thread. Reads nothing from disk, so a Session from an earlier Runtime is refused. Never creates a
   * replacement Provider thread or replays a Turn.
   */
  async resumeSession(sessionId: string): Promise<PedelecNodeSession> {
    if (this.closed) throw new PedelecError('CLIENT_CLOSED', 'runtime is closed');
    if (arguments.length !== 1 || !isSafeId(sessionId)) throw new PedelecError('INVALID_INPUT', 'resumeSession requires exactly one sessionId');
    const held = this.sessions.get(sessionId);
    if (held && !held.isRetired() && !this.suspendedRoots.has(held.runtimeStorageRoot)) return held;
    if (this.reserved.has(sessionId)) throw new PedelecError('DUPLICATE_SESSION', 'session is already being opened');
    throw new PedelecError('SESSION_NOT_ACTIVE', 'this Runtime holds no such session');
  }

  /**
   * Hands a recoverable ended Session to a new owner. The current handle is retired before this returns, so a stale
   * reference can neither send nor resume; the returned offline handle has the same Provider identity and keeps its
   * FIFO position. Synchronous on purpose: two claimants cannot both pass the checks. The caller then uses resume().
   */
  replaceEndedSession(sessionId: string): PedelecNodeSession {
    if (this.closed) throw new PedelecError('CLIENT_CLOSED', 'runtime is closed');
    if (!isSafeId(sessionId)) throw new PedelecError('INVALID_INPUT', 'sessionId is invalid');
    const current = this.sessions.get(sessionId);
    if (this.reserved.has(sessionId) || current?.isResuming()) throw new PedelecError('DUPLICATE_SESSION', 'session is being resumed');
    if (!current || this.suspendedRoots.has(current.runtimeStorageRoot) || current.getStatus() !== 'ended' || !current.mayReactivateAfterEnded()) {
      throw new PedelecError('SESSION_NOT_ACTIVE', 'session is not a recoverable ended session');
    }
    let replacement!: PedelecNodeSession;
    replacement = new PedelecNodeSession({
      sessionId, providerSessionId: current.providerSessionId, provider: current.provider, workdir: current.workdir,
      runtimeStorageRoot: current.runtimeStorageRoot,
      artifactDirectory: current.artifactDirectory, providerStateDirectory: current.providerStateDirectory,
      hostInstructions: current.hostInstructions, model: current.model, effort: current.effort, tools: current.tools,
      capabilities: current.capabilities, initialStatus: 'ended', cliOnly: this.cliOnly,
      sendTimeoutMs: this.sendTimeoutMs, toolReplyTimeoutMs: this.toolReplyTimeoutMs,
      onDisposed: () => { this.released(replacement); },
      observe: this.monitor.observe, detailedMonitoring: this.detailedMonitoring,
      resumeEnded: () => this.trackOpen(replacement.runtimeStorageRoot, () => this.reactivateEndedSession(replacement)),
    });
    this.sessions.set(sessionId, replacement);
    this.endedHandles.set(sessionId, replacement);
    const predecessor = this.retireAndWait(current);
    void predecessor.catch(() => undefined);
    this.predecessors.set(replacement, predecessor);
    return replacement;
  }

  /** Explicit reactivation of an ended handle; Host authorization belongs to the caller. */
  private async reactivateEndedSession(session: PedelecNodeSession): Promise<void> {
    if (this.closed) throw new PedelecError('CLIENT_CLOSED', 'runtime is closed');
    if (session.getStatus() !== 'ended') throw new PedelecError('SESSION_NOT_ACTIVE', 'session is not ended');
    if (!session.mayReactivateAfterEnded()) throw new PedelecError('SESSION_NOT_ACTIVE', 'technical session identity is not reactivatable');
    try {
      await this.predecessors.get(session);
      await session.prepareEndedReactivation();
      await this.open({
        sessionId: session.sessionId, provider: session.provider, model: session.model, effort: session.effort,
        workdir: session.workdir, tools: session.tools, hostInstructions: session.hostInstructions,
        runtimeStorageRoot: session.runtimeStorageRoot,
      }, session.providerSessionId, session);
    } catch (error) {
      session.failReactivation();
      if (this.endedHandles.get(session.sessionId) === session) this.endedHandles.delete(session.sessionId);
      throw error;
    }
  }

  private async retireAndWait(session: PedelecNodeSession): Promise<void> {
    await Promise.all([session.dispose(), this.predecessors.get(session)]);
    await session.whenStopped();
    if (!session.isWorkerStopped()) throw new PedelecError('TRANSPORT_UNAVAILABLE', 'worker stop is unconfirmed');
  }

  private async trackOpen<T>(raw: unknown, open: () => Promise<T>): Promise<T> {
    if (this.closed) throw new PedelecError('CLIENT_CLOSED', 'runtime is closed');
    const root = storageRoot(raw);
    if (this.suspendedRoots.has(root)) throw new PedelecError('SESSION_NOT_ACTIVE', 'runtime storage is unavailable');
    const opening = open();
    this.opens.set(opening, root);
    try { return await opening; }
    finally { this.opens.delete(opening); }
  }

  private bindStorage(root: string): Promise<StorageKeeper> {
    const held = this.roots.get(root);
    if (held) return held;
    const binding = StorageKeeper.start(this.workerPath, root, this.instanceId);
    this.roots.set(root, binding);
    void binding.catch(() => { if (this.roots.get(root) === binding) this.roots.delete(root); });
    return binding;
  }

  /**
   * Stops new opens/resumes on this root and checks that its writers have exited. The Host holds this guard while
   * committing the workspace deletion. Seal leaves a durable tombstone before releasing the OS locks for rename.
   */
  async prepareStorageRootDeletion(raw: string): Promise<Readonly<{ seal(): Promise<void>; release(): Promise<void> }>> {
    const root = storageRoot(raw);
    if (this.closed || this.suspendedRoots.has(root)) throw new PedelecError('SESSION_NOT_ACTIVE', 'runtime storage is unavailable');
    this.suspendedRoots.add(root);
    let keeper: StorageKeeper | undefined;
    const held = this.roots.get(root);
    let sealed = false;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (sealed) return;
      try {
        if (held) await keeper?.command({ action: 'thaw' });
        else await keeper?.close();
      } finally {
        this.suspendedRoots.delete(root);
      }
    };
    try {
      await Promise.allSettled([...this.opens].filter(([, path]) => path === root).map(([opening]) => opening));
      await Promise.all([...this.evictions].filter(([, path]) => path === root).map(([eviction]) => eviction));
      const sessions = this.listSessions().filter((session) => session.runtimeStorageRoot === root);
      await Promise.all(sessions.map((session) => this.predecessors.get(session)));
      if (sessions.some((session) => !session.isWorkerStopped())) {
        throw new PedelecError('SESSION_NOT_ACTIVE', 'runtime storage still has a worker');
      }
      keeper = await (held ?? StorageKeeper.start(this.workerPath, root, null));
      await keeper.command({ action: 'freeze' });
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
    return {
      seal: async () => {
        if (released) throw new PedelecError('SESSION_NOT_ACTIVE', 'runtime storage guard was released');
        await keeper!.command({ action: 'seal' });
        sealed = true;
        try {
          const sessions = this.listSessions().filter((session) => session.runtimeStorageRoot === root);
          await Promise.all(sessions.map((session) => this.retireAndWait(session)));
        } finally {
          await keeper!.close();
          this.roots.delete(root);
        }
      },
      release,
    };
  }

  /** Stops every worker this client created and releases its storage ownership. Further sessions are refused. */
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    await Promise.allSettled(this.opens.keys());
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((session) => this.retireAndWait(session)));
    this.endedHandles.clear();
    await Promise.all(this.evictions.keys());
    await Promise.allSettled([...this.roots.values()].map(async (keeper) => (await keeper).close()));
    this.roots.clear();
  }

  private async open(input: CreateSessionInput, providerSessionId: string | null, endedHandle?: PedelecNodeSession): Promise<PedelecNodeSession> {
    if (this.closed) throw new PedelecError('CLIENT_CLOSED', 'runtime is closed');
    if (!isRecord(input)) throw new PedelecError('INVALID_INPUT', 'session input must be an object');
    if (Object.keys(input).some((key) => !['sessionId', 'provider', 'model', 'effort', 'workdir', 'tools', 'hostInstructions', 'runtimeStorageRoot'].includes(key))) {
      throw new PedelecError('INVALID_INPUT', 'unexpected session input field');
    }
    if (!SUPPORTED_PROVIDERS.has(input.provider)) throw new PedelecError('UNSUPPORTED_PROVIDER', 'provider is not supported');
    validateText(input.model, 'model', 256);
    validateText(input.effort, 'effort', 32);
    if (typeof input.workdir !== 'string' || !isAbsolute(input.workdir) || input.workdir.includes('\0')) {
      throw new PedelecError('INVALID_INPUT', 'workdir must be an absolute Server path');
    }
    if (input.hostInstructions !== undefined && (typeof input.hostInstructions !== "string"
      || Buffer.byteLength(input.hostInstructions) > 16 * 1024 || input.hostInstructions.includes("\0"))) {
      throw new PedelecError("INVALID_INPUT", "hostInstructions are invalid");
    }
    const root = storageRoot(input.runtimeStorageRoot);
    let tools: readonly PedelecToolDescriptor[];
    try { tools = normalizeTools(input.tools); } catch { throw new PedelecError('INVALID_INPUT', 'tools are invalid'); }
    const capability = PROVIDER_CAPABILITIES[input.provider];
    if (!capability?.supported || (tools.length > 0 && capability.hostTools !== true)) {
      throw new PedelecError('UNSUPPORTED_PROVIDER', 'provider has no Host Tool transport for this session');
    }
    const sessionId = input.sessionId ?? randomUUID();
    if (!isSafeId(sessionId)) throw new PedelecError('INVALID_INPUT', 'sessionId is invalid');
    const hostInstructions = composeInstructions(input.hostInstructions ?? '', sessionId, tools);
    if (Buffer.byteLength(hostInstructions) > MAX_INSTRUCTION_BYTES) throw new PedelecError('INVALID_INPUT', 'hostInstructions with tool guidance are too long');
    if ((this.sessions.has(sessionId) && this.sessions.get(sessionId) !== endedHandle)
      || this.reserved.has(sessionId)) throw new PedelecError('DUPLICATE_SESSION', 'sessionId is already in use');
    const provider = input.provider as PedelecProvider;
    this.reserved.add(sessionId);
    let connection: PedelecTransportConnection;
    let cliEndpoint: CliEndpoint | undefined;
    const paths = sessionStorage(root, this.instanceId, sessionId, provider);
    try {
      const keeper = await this.bindStorage(root);
      const identity = { session: paths.segment, ollama: provider === 'ollama' };
      await keeper.command({ action: endedHandle ? 'resume' : 'prepare', ...identity });
      const artifacts = new ArtifactStore(paths.artifactDirectory, paths.segment, async () => {
        try { await keeper.command({ action: 'discard-staging', ...identity }); }
        catch (error) { keeper.reportIncomplete(error); }
      });
      if (this.cliOnly) {
        const binDir = dirname(this.workerPath);
        await access(join(binDir, `pedelec-cli${process.platform === 'win32' ? '.exe' : ''}`));
        cliEndpoint = await CliEndpoint.start(sessionId, tools);
      }
      try { connection = await this.transport.connect({
        ...paths.env,
        ...(cliEndpoint && {
          PEDELEC_CORE_IPC_RUNTIME_FILE: cliEndpoint.runtimeFile,
          PATH: `${dirname(this.workerPath)}${delimiter}${process.env.PATH ?? ''}`,
        }),
      }); }
      catch (error) {
        this.monitor.observe({ kind: 'session.open-failed', sessionId, turnId: null, data: () => ({ transportCode: transportCodeOf(error) ?? null }) });
        throw new PedelecError('TRANSPORT_UNAVAILABLE', 'agent worker could not start', transportCodeOf(error), error);
      }
      const tap = (record: Readonly<Record<string, unknown>>) => {
        this.monitor.observe({ kind: record.kind as MonitorInput['kind'], sessionId, turnId: null, data: () => record });
      };
      connection.on('monitor', tap);
      const untap = () => { connection.removeListener?.('monitor', tap as (...args: unknown[]) => void); };
      const payload = {
        requestId: randomUUID(), sessionId, provider, model: input.model, effort: input.effort,
        serverWorkdir: input.workdir, hostInstructions, tools,
        // Same filesystem as the final directory, so landing an artifact is an atomic rename.
        artifactStagingDir: artifacts.stagingDirectory,
        ...(paths.providerStateDirectory === undefined ? {} : { providerStateDir: paths.providerStateDirectory }),
      };
      let confirmedProviderSessionId: string;
      let receipt: Record<string, unknown>;
      try {
        if (providerSessionId === null) {
          const opened = await connection.openSession(payload, { timeoutMs: OPEN_TIMEOUT_MS });
          if (!isRecord(opened.data) || opened.data.provider !== provider || typeof opened.data.providerSessionId !== 'string'
            || !opened.data.providerSessionId.trim()) throw new PedelecError('PROVIDER_REJECTED', 'provider session was not confirmed');
          if ((opened.data.runtimeStarted !== true || !isRecord(opened.data.capabilities)
            || opened.data.capabilities.send !== 'supported')) throw new PedelecError('PROVIDER_REJECTED', 'provider capability was not confirmed');
          receipt = opened.data;
          confirmedProviderSessionId = opened.data.providerSessionId;
        } else {
          if (typeof connection.rehydrateSession !== 'function') throw new PedelecError('TRANSPORT_UNAVAILABLE', 'transport cannot attach');
          const response = await connection.rehydrateSession({ ...payload, providerSessionId }, { timeoutMs: OPEN_TIMEOUT_MS });
          if (!isRecord(response.data) || response.data.provider !== provider || response.data.rehydrated !== true
            || response.data.providerSessionId !== providerSessionId) throw new PedelecError('PROVIDER_REJECTED', 'provider session could not be attached');
          receipt = response.data;
          confirmedProviderSessionId = providerSessionId;
        }
      } catch (error) {
        this.monitor.observe({ kind: 'session.open-failed', sessionId, turnId: null, data: () => ({ transportCode: transportCodeOf(error) ?? null }) });
        await this.cleanup(connection, sessionId);
        untap();
        if (error instanceof PedelecError) throw error;
        throw new PedelecError('PROVIDER_REJECTED', 'provider session could not be opened', transportCodeOf(error), error);
      }
      const operations = isRecord(receipt.capabilities) ? receipt.capabilities : {};
      // A Session with Tools needs the Worker's word that this Provider's shell got the CLI.
      if (this.cliOnly && tools.length > 0 && operations['cli-tool-transport'] !== 'supported') {
        await this.cleanup(connection, sessionId);
        untap();
        throw new PedelecError('PROVIDER_REJECTED', 'provider did not confirm the Host Tool transport');
      }
      let session!: PedelecNodeSession;
      const init: SessionInit = {
        capabilities: Object.freeze({
          runtimeOpen: receipt.runtimeStarted === true, sendTurn: operations.send === 'supported',
          hostTools: capability.hostTools === true && operations['cli-tool-transport'] === 'supported',
          cancelTurn: operations.cancel === 'supported' ? 'native' : operations.cancel === 'process-stop' ? 'process-stop' : 'unsupported',
          resumeSession: operations['resume-provider'] === 'supported', monitorMetadata: receipt.runtimeStarted === true,
        }),
        // Level 1 tool-trace adapter declared by this Worker; an older Worker that says nothing is `unknown`, never `supported`.
        toolTraceCoverage: parseCoverage(isRecord(receipt.toolTrace) ? receipt.toolTrace.coverage : undefined),
        sessionId, providerSessionId: confirmedProviderSessionId, provider, workdir: input.workdir, runtimeStorageRoot: root,
        artifactDirectory: paths.artifactDirectory, providerStateDirectory: paths.providerStateDirectory, hostInstructions: input.hostInstructions ?? '', model: input.model,
        effort: input.effort, tools, connection, cliEndpoint, artifacts, cliOnly: this.cliOnly, sendTimeoutMs: this.sendTimeoutMs, toolReplyTimeoutMs: this.toolReplyTimeoutMs,
        onDisposed: () => {
          untap();
          this.released(session);
        },
        observe: this.monitor.observe, detailedMonitoring: this.detailedMonitoring,
        resumeEnded: () => this.trackOpen(session.runtimeStorageRoot, () => this.reactivateEndedSession(session)),
        afterEnded: async () => {
          if (session.getStatus() === 'ended' && session.mayReactivateAfterEnded()) await this.retainEndedHandle(session);
        },
      };
      if (endedHandle) {
        session = endedHandle;
        // A dispose that won the race leaves this Worker unowned, so it stops here instead of leaking.
        try { session[reactivateConnection](init); }
        catch (error) {
          await this.cleanup(connection, sessionId);
          untap();
          throw error;
        }
      } else {
        session = new PedelecNodeSession(init);
      }
      this.sessions.set(sessionId, session);
      if (endedHandle) this.endedHandles.delete(sessionId);
      this.monitor.observe({
        kind: 'session.opened', sessionId, turnId: null,
        data: () => ({
          providerSessionId: confirmedProviderSessionId, provider, model: input.model, effort: input.effort,
          workerPid: connection.pid ?? null, attached: providerSessionId !== null, status: session.getStatus(),
        }),
      });
      if (this.closed) { await session.dispose(); throw new PedelecError('CLIENT_CLOSED', 'runtime is closed'); }
      return session;
    } catch (error) {
      await cliEndpoint?.close();
      throw error;
    } finally {
      this.reserved.delete(sessionId);
    }
  }

  private async cleanup(connection: PedelecTransportConnection, sessionId: string): Promise<void> {
    try { await connection.closeSession({ requestId: randomUUID(), sessionId, reason: 'Session could not be opened.' }, { timeoutMs: 1000 }); }
    catch { /* The provider session may not exist. */ }
    try { await connection.shutdown({ graceMs: 100, timeoutMs: 1000 }); }
    catch { await connection.terminate({ graceMs: 100 }).catch(() => undefined); }
  }
}

export async function createPedelecRuntime(options: PedelecRuntimeOptions = {}): Promise<PedelecNodeClient> {
  return new PedelecNodeClient(options);
}
