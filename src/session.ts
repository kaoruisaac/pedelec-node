import { randomUUID } from 'node:crypto';
import { AgentToolTracer } from './agent-tool-trace.ts';
import { ListenerSet } from './events.ts';
import type { MonitorInput, MonitorObserver } from './monitor.ts';
import type { ArtifactStore } from './artifacts.ts';
import { PedelecError, transportCodeOf } from './errors.ts';
import { boundedJson } from './tools.ts';
import { CliEndpoint, cliError, type CliReply } from './transport/cli-endpoint.ts';
import type { PedelecTransportConnection, TransportEvent } from './transport/rust-ipc.ts';
import type {
  AgentToolCoverage, AgentToolEventListener, AgentToolStatus, PedelecArtifact, PedelecArtifactContext, PedelecChatContext, PedelecEndedReason, PedelecErrorCategory, PedelecProvider,
  PedelecSessionCapabilities, PedelecSessionContext, PedelecSessionError, PedelecSessionStatus, PedelecToolCallState, PedelecToolContext,
  PedelecToolDescriptor, PedelecToolHandler, PedelecTurnOutcome, PedelecTurnTerminal, Unsubscribe,
} from './types.ts';

export const MAX_ID_BYTES = 128;
export const MAX_SEND_TEXT_BYTES = 512 * 1024;
export const MAX_REASON_BYTES = 500;
const CLOSE_TIMEOUT_MS = 2_000;
/** Longer than the Worker's own stop deadline, so a real provider terminal wins. */
const CANCEL_TERMINAL_GRACE_MS = 12_000;
const MAX_ARTIFACT_KEYS = 4096;
const ARTIFACT_FAILURE_CODE = /^[A-Z0-9_]{1,64}$/;

type ToolCall = { readonly toolCallId: string; readonly toolName: string; state: PedelecToolCallState };

type ActiveTurn = {
  readonly turnId: string;
  readonly controller: AbortController;
  assistantText: string;
  finalAssistantText: string | null;
  truncated: boolean;
  /** One callback per turn: none → running → acknowledged | unknown. */
  callbackState: 'none' | 'running' | 'acknowledged' | 'unknown';
  replyAttempted: boolean;
  cancelRequested: boolean;
  readonly toolCalls: ToolCall[];
};

export const reactivateConnection = Symbol('reactivateConnection');

export type SessionInit = Readonly<{
  sessionId: string;
  providerSessionId: string;
  provider: PedelecProvider;
  workdir: string;
  runtimeStorageRoot: string;
  artifactDirectory: string;
  providerStateDirectory?: string;
  hostInstructions: string;
  model: string;
  effort: string;
  tools: readonly PedelecToolDescriptor[];
  capabilities?: PedelecSessionCapabilities;
  connection?: PedelecTransportConnection;
  /** Ended handles attach without a Worker; resume() performs the Provider rehydrate. */
  initialStatus?: 'ended';
  resumeEnded?: () => Promise<void>;
  cliEndpoint?: CliEndpoint;
  artifacts?: ArtifactStore;
  cliOnly?: boolean;
  sendTimeoutMs: number;
  toolReplyTimeoutMs: number;
  onDisposed: (sessionId: string) => void;
  observe: MonitorObserver;
  detailedMonitoring?: boolean;
  /** SDK-private lifecycle maintenance; never counted as a Host onEnded subscriber. */
  afterEnded?: () => Promise<void>;
  /** Level 1 tool-trace adapter coverage from the Worker receipt; absent means `unknown`. */
  toolTraceCoverage?: AgentToolCoverage;
}>;

/** Host refusals for malformed input are `failed`; refusals of state or policy are `denied`. */
const INVALID_INPUT_REFUSALS = new Set(['TOOL_ARGS_INVALID', 'TOOL_SCHEMA_INVALID', 'TOOL_NOT_FOUND', 'REQUEST_ID_CONFLICT']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_ID_BYTES && !/[\u0000-\u001f]/.test(value);
}

function assertReason(reason: unknown): asserts reason is string {
  if (typeof reason !== 'string' || !reason.trim() || Buffer.byteLength(reason) > MAX_REASON_BYTES || reason.includes('\0')) {
    throw new PedelecError('INVALID_INPUT', 'reason must be a non-empty string of at most 500 bytes');
  }
}

const ERROR_MESSAGES: Readonly<Record<PedelecErrorCategory, string>> = Object.freeze({
  TRANSPORT_FAILURE: 'The agent transport failed; the current outcome is unknown.',
  WORKER_CRASHED: 'The agent worker exited unexpectedly.',
  PROVIDER_ERROR: 'The provider reported a protocol error.',
  EVENT_SEQUENCE_REVERSED: 'An agent event arrived out of order.',
  TOOL_REQUEST_REJECTED: 'A tool request did not match the active turn and was refused.',
  TOOL_HANDLER_FAILED: 'A tool handler did not return a confirmed result.',
  TOOL_RESULT_INVALID: 'A tool handler returned a result that is not bounded JSON.',
  TOOL_ACK_UNKNOWN: 'The provider acknowledgement of a tool reply could not be confirmed.',
  CHAT_HANDLER_FAILED: 'A chat handler failed while recording the completed message.',
  ARTIFACT_STORAGE_FAILED: 'A provider artifact could not be validated or stored.',
  ARTIFACT_HANDLER_FAILED: 'An artifact handler failed after the file was stored.',
});

/**
 * One provider session over one transport connection. This is the single owner of turn, callback,
 * cancel and unknown-outcome state; Server adapters only register handlers and react to outcomes.
 */
export class PedelecNodeSession {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly provider: PedelecProvider;
  readonly workdir: string;
  readonly #storagePaths: Readonly<Pick<SessionInit, 'runtimeStorageRoot' | 'artifactDirectory' | 'providerStateDirectory'>>;
  get runtimeStorageRoot(): string { return this.#storagePaths.runtimeStorageRoot; }
  get artifactDirectory(): string { return this.#storagePaths.artifactDirectory; }
  get providerStateDirectory(): string | undefined { return this.#storagePaths.providerStateDirectory; }
  readonly hostInstructions: string;
  readonly model: string;
  readonly effort: string;
  readonly tools: readonly PedelecToolDescriptor[];
  capabilities: PedelecSessionCapabilities;

  private connection!: PedelecTransportConnection;
  private cliEndpoint?: CliEndpoint;
  private artifactStore?: ArtifactStore;
  private readonly artifactKeys = new Set<string>();
  private readonly cliOnly: boolean;
  private readonly sendTimeoutMs: number;
  private readonly toolReplyTimeoutMs: number;
  private onDisposed: (sessionId: string) => void;
  private readonly resumeEnded?: () => Promise<void>;
  private reactivationPromise: Promise<void> | null = null;
  private readonly observe: MonitorObserver;
  private readonly detailedMonitoring: boolean;
  private afterEnded?: () => Promise<void>;
  private status: PedelecSessionStatus = 'idle';
  private turn: ActiveTurn | null = null;
  private eventQueue: Promise<void> = Promise.resolve();
  private lastSequence = 0;
  private disposed = false;
  /** Irreversible: this object was disposed, evicted or replaced, so it can never run a Turn or resume again. */
  private retired = false;
  private resumeAfterEnded = false;
  private reactivating = false;
  /** Set while close/dispose is stopping the Worker; a later resume must not overlap it. */
  private stopping: Promise<void> | null = null;
  private workerStopAttempted = false;
  /** Irreversible: the transport can no longer be trusted, so no later event may run a tool or report success. */
  private faulted = false;
  /** A fault frame arrived but has not left the event queue; a running handler must already stop. */
  private faultPending = false;
  private endedReported = false;
  private readonly turnIds = new Set<string>();
  private readonly callbackKeys = new Set<string>();
  private readonly toolHandlers = new Map<string, PedelecToolHandler>();
  private readonly chat = new ListenerSet<[string, PedelecChatContext]>();
  private readonly chatDelta = new ListenerSet<[string, PedelecChatContext]>();
  private readonly artifactLanded = new ListenerSet<[PedelecArtifact, PedelecArtifactContext]>();
  private readonly statusListeners = new ListenerSet<[PedelecSessionStatus, PedelecSessionContext]>();
  private readonly errors = new ListenerSet<[PedelecSessionError, PedelecSessionContext]>();
  private readonly turnEnded = new ListenerSet<[PedelecTurnOutcome, PedelecSessionContext]>();
  private readonly ended = new ListenerSet<[PedelecEndedReason, PedelecSessionContext]>();
  private listeners: ReadonlyArray<readonly [string, (...args: unknown[]) => void]> = [];
  /** Read-only Agent Tool observation; never consulted by any Tool, Turn or ACK decision. */
  private readonly trace: AgentToolTracer;

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId;
    this.providerSessionId = init.providerSessionId;
    this.provider = init.provider;
    this.workdir = init.workdir;
    this.#storagePaths = Object.freeze({
      runtimeStorageRoot: init.runtimeStorageRoot,
      artifactDirectory: init.artifactDirectory,
      providerStateDirectory: init.providerStateDirectory,
    });
    this.hostInstructions = init.hostInstructions;
    this.model = init.model;
    this.effort = init.effort;
    this.tools = init.tools;
    this.cliOnly = init.cliOnly ?? false;
    this.sendTimeoutMs = init.sendTimeoutMs;
    this.toolReplyTimeoutMs = init.toolReplyTimeoutMs;
    this.onDisposed = init.onDisposed;
    this.resumeEnded = init.resumeEnded;
    this.status = init.initialStatus ?? 'idle';
    this.observe = init.observe;
    this.detailedMonitoring = init.detailedMonitoring === true;
    this.afterEnded = init.afterEnded;
    // An offline ended handle exists only to reach the same Provider Session again.
    this.resumeAfterEnded = init.initialStatus === 'ended';
    this.capabilities = Object.freeze(init.capabilities ?? {
      runtimeOpen: false, sendTurn: false, hostTools: false, cancelTurn: 'unsupported', resumeSession: false, monitorMetadata: false,
    });
    this.trace = new AgentToolTracer({
      sessionId: this.sessionId, provider: this.provider, coverage: init.toolTraceCoverage ?? 'unknown',
      knownTurn: (turnId) => this.turnIds.has(turnId), activeTurn: () => this.turn?.turnId ?? null,
    });
    if (init.connection) this.bindConnection(init);
  }

  /** Binds a live Worker. An offline ended handle has none until resume() confirms the Provider Session. */
  private bindConnection(init: SessionInit): void {
    if (!init.connection) throw new PedelecError('SESSION_NOT_ACTIVE', 'transport is not available');
    this.connection = init.connection;
    this.workerStopAttempted = false;
    this.cliEndpoint = init.cliEndpoint;
    this.artifactStore = init.artifacts;
    this.onDisposed = init.onDisposed;
    this.afterEnded = init.afterEnded;
    this.capabilities = Object.freeze(init.capabilities ?? this.capabilities);
    this.trace.setCoverage(init.toolTraceCoverage ?? 'unknown');
    this.cliEndpoint?.bind({
      activeTurn: () => !this.disposed && !this.faulted && !this.faultPending && this.status === 'busy' && !this.turn?.cancelRequested ? this.turn?.turnId ?? null : null,
      execute: (id, name, args, deliver) => this.handleToolRequest({ turnId: this.turn?.turnId, toolCallId: id, toolName: name, args }, deliver),
      artifactHook: async (stage, hookPayload) => {
        if (typeof this.connection.providerArtifactHook !== 'function') throw new Error('HOOK_UNAVAILABLE');
        await this.connection.providerArtifactHook(
          { requestId: randomUUID(), sessionId: this.sessionId, stage, hookPayload },
          { timeoutMs: this.sendTimeoutMs },
        );
      },
      unknown: () => { this.markFaulted(); },
      // Stale or no-Turn refusals name no Turn, so they can never be linked to a native call of the current one.
      refused: (id, name, args, code) => this.trace.hostRefused({
        turnId: code === 'STALE_TURN' || code === 'SESSION_NOT_ACTIVE' ? null : this.turn?.turnId ?? null,
        hostToolCallId: id, toolName: name, args, errorCode: code, status: INVALID_INPUT_REFUSALS.has(code) ? 'failed' : 'denied',
      }),
    });
    const onEvent = (event: TransportEvent) => {
      // Latched before queueing: a Tool handler may be holding the queue right now.
      if (event.sessionId === this.sessionId && (event.kind === 'provider-error' || event.kind === 'crash')) {
        this.faultPending = true;
        this.turn?.controller.abort();
      }
      this.eventQueue = this.eventQueue.then(() => this.handleEvent(event)).catch(() => {
        this.markFaulted();
      });
      this.observeFrame(event);
    };
    const onCrash = () => { void this.handleWorkerLoss('WORKER_CRASHED'); };
    const onFailure = () => { void this.handleWorkerLoss('TRANSPORT_FAILURE'); };
    this.connection.on('event', onEvent);
    this.connection.on('crash', onCrash);
    this.connection.on('failure', onFailure);
    this.listeners = [['event', onEvent], ['crash', onCrash], ['failure', onFailure]] as never;
  }

  /** Release an old ended Worker, if the Provider terminated without an explicit Host close. */
  async prepareEndedReactivation(): Promise<void> {
    if (this.status !== 'ended' || this.retired) throw new PedelecError('SESSION_NOT_ACTIVE', 'session is not ended');
    await this.stopping;
    if (this.listeners.length > 0) {
      this.disposed = true;
      await this.cliEndpoint?.close().catch(() => undefined);
      await this.stopWorker();
      if (this.connection.closed === false) throw new PedelecError('TRANSPORT_UNAVAILABLE', 'previous worker stop is unconfirmed');
      await this.artifactStore?.cleanup();
      this.release();
    }
    // The new Worker restarts its event sequence at 1; never process an old queued frame after revival.
    await this.eventQueue;
    this.eventQueue = Promise.resolve();
    this.lastSequence = 0;
  }

  /** Called only after a Provider rehydrate with this handle's exact identity succeeds. */
  [reactivateConnection](init: SessionInit): void {
    if (this.status !== 'ended' || this.reactivationPromise === null || this.retired
      || init.runtimeStorageRoot !== this.runtimeStorageRoot || init.artifactDirectory !== this.artifactDirectory
      || init.providerStateDirectory !== this.providerStateDirectory) {
      throw new PedelecError('SESSION_NOT_ACTIVE', 'session was not awaiting reactivation');
    }
    this.disposed = false;
    this.faulted = false;
    this.faultPending = false;
    this.endedReported = false;
    this.resumeAfterEnded = false;
    this.bindConnection(init);
    this.reactivating = true;
    try { this.setStatus('idle'); }
    finally { this.reactivating = false; }
  }

  /** Like original Pedelec session.resume(): ended -> idle after Provider identity is confirmed. */
  resume(): Promise<void> {
    if (this.retired) return Promise.reject(new PedelecError('SESSION_NOT_ACTIVE', 'session handle was retired'));
    if (this.status !== 'ended') return Promise.resolve();
    if (!this.resumeEnded) return Promise.reject(new PedelecError('SESSION_NOT_ACTIVE', 'session reactivation is unavailable'));
    if (this.reactivationPromise) return this.reactivationPromise;
    const request = Promise.resolve().then(() => this.resumeEnded!());
    const guarded = request.finally(() => {
      if (this.reactivationPromise === guarded) this.reactivationPromise = null;
    });
    this.reactivationPromise = guarded;
    return guarded;
  }

  /** A failed rehydrate may already have reached the Provider: never retried, never eligible again. */
  failReactivation(): void {
    this.resumeAfterEnded = false;
    if (this.retired || this.status !== 'ended') return;
    this.reactivating = true;
    try { this.setStatus('unavailable'); }
    finally { this.reactivating = false; }
  }

  /** True while resume() owns this handle: disposing it now would race the Provider rehydrate. */
  isResuming(): boolean { return this.reactivationPromise !== null; }
  /** An explicit clean end (or a confirmed idle Provider close) is recoverable; unknown Turns are not. */
  mayReactivateAfterEnded(): boolean { return this.resumeAfterEnded && !this.retired; }
  /** True once this object was disposed, evicted or replaced. Nothing can revive it. */
  isRetired(): boolean { return this.retired; }
  /**
   * True only when no Worker can still be running for this handle: none was ever bound, or a stop was attempted and the
   * transport did not report the process as still alive. A Host may use it to decide that a faulted Session has settled.
   */
  isWorkerStopped(): boolean {
    if (!this.connection) return true;
    return this.workerStopAttempted && this.stopping === null && this.connection.closed !== false;
  }
  /** Resolves when a close or dispose already in progress finished stopping the Worker. */
  whenStopped(): Promise<void> { return this.stopping ?? Promise.resolve(); }

  getStatus(): PedelecSessionStatus {
    return this.status;
  }

  getActiveTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  onChat(listener: (content: string, context: PedelecChatContext) => void | Promise<void>): Unsubscribe {
    return this.chat.add(listener);
  }

  /** Optional live text for UI. It is not a conversation authority; persist from onChat only. */
  onChatDelta(listener: (text: string, context: PedelecChatContext) => void): Unsubscribe {
    return this.chatDelta.add(listener);
  }

  /**
   * Fires after a Provider artifact has landed at its final `path`, once per Provider item. It is independent of `onTool`
   * and of the Turn's outcome: a file produced before a failed or cancelled Turn stays and still names that Turn.
   */
  onArtifact(listener: (artifact: PedelecArtifact, context: PedelecArtifactContext) => void | Promise<void>): Unsubscribe {
    return this.artifactLanded.add(listener);
  }

  onStatus(listener: (status: PedelecSessionStatus, context: PedelecSessionContext) => void | Promise<void>): Unsubscribe {
    return this.statusListeners.add(listener);
  }

  onError(listener: (error: PedelecSessionError, context: PedelecSessionContext) => void | Promise<void>): Unsubscribe {
    return this.errors.add(listener);
  }

  onTurnEnded(listener: (outcome: PedelecTurnOutcome, context: PedelecSessionContext) => void | Promise<void>): Unsubscribe {
    return this.turnEnded.add(listener);
  }

  onEnded(listener: (reason: PedelecEndedReason, context: PedelecSessionContext) => void | Promise<void>): Unsubscribe {
    return this.ended.add(listener);
  }

  /**
   * Read-only observation of the Agent's real Tool Invocations: Provider-native tools (Shell, files, search, MCP, …) and
   * Host Tools reached through `pedelec-cli`. Unlike `onTool`, it never executes or answers anything. Event-first:
   * each Provider/Host fact is delivered once, in order, with no SDK dedupe, inferred phase or synthetic terminal.
   * Values are size-bounded (`detailTruncated`) but **not redacted** — the consumer owns ACL, display redaction and
   * retention. Events are frozen and delivered asynchronously on a bounded per-listener queue; a slow, throwing or
   * rejecting listener only loses its own events (announced by `observation-gap`) and never delays a Tool, ACK or Turn.
   * Only listeners registered when an event is published receive it; nothing is stored or replayed.
   */
  onAgentToolEvent(listener: AgentToolEventListener): Unsubscribe {
    return this.trace.subscribe(listener);
  }

  /** Registers the single handler for a tool declared at creation. All declared tools need one before the first send. */
  onTool(name: string, handler: PedelecToolHandler): Unsubscribe {
    if (!this.tools.some((tool) => tool.name === name)) throw new PedelecError('INVALID_INPUT', 'tool was not declared for this session');
    if (typeof handler !== 'function') throw new PedelecError('INVALID_INPUT', 'tool handler must be a function');
    if (this.toolHandlers.has(name)) throw new PedelecError('INVALID_INPUT', 'tool handler is already registered');
    this.toolHandlers.set(name, handler);
    return () => { if (this.toolHandlers.get(name) === handler) this.toolHandlers.delete(name); };
  }

  /** Resolves once the provider accepted the turn. Completion arrives through onChat/onTurnEnded/onError. */
  async sendText(text: string, options: Readonly<{ turnId?: string }> = {}): Promise<{ accepted: true; sessionId: string; turnId: string }> {
    // No Provider has an input path for these, so they are refused rather than silently dropped.
    if ((options as Readonly<{ attachments?: unknown }>).attachments !== undefined) throw new PedelecError('INVALID_INPUT', 'attachments are not supported by this provider');
    const turnId = options.turnId ?? randomUUID();
    if (!isSafeId(turnId)) throw new PedelecError('INVALID_INPUT', 'turnId must be a non-empty id of at most 128 bytes');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > MAX_SEND_TEXT_BYTES) {
      throw new PedelecError('INVALID_INPUT', 'text must be non-empty and within the send limit');
    }
    if (this.status === 'ended' || this.disposed) throw new PedelecError('SESSION_NOT_ACTIVE', 'session has ended');
    if (this.status !== 'idle' || this.turn) throw new PedelecError('SESSION_BUSY', 'session is not idle');
    if (this.turnIds.has(turnId)) throw new PedelecError('DUPLICATE_TURN', 'turnId was already used in this session');
    if (this.tools.some((tool) => !this.toolHandlers.has(tool.name))) {
      throw new PedelecError('HANDLER_MISSING', 'every declared tool needs a handler before the first send');
    }
    const turn: ActiveTurn = {
      turnId, controller: new AbortController(), assistantText: '', finalAssistantText: null, truncated: false,
      callbackState: 'none', replyAttempted: false, cancelRequested: false, toolCalls: [],
    };
    this.turnIds.add(turnId);
    this.turn = turn;
    this.trace.turnStarted(turnId);
    this.setStatus('busy');
    this.emitMonitor('turn.send', () => ({ bytes: Buffer.byteLength(text, 'utf8') }), turnId);
    try {
      await this.cliEndpoint?.rotate();
      const sent = await this.connection.send(
        { requestId: randomUUID(), sessionId: this.sessionId, turnId, text },
        { timeoutMs: this.sendTimeoutMs },
      );
      if (!isRecord(sent.data) || sent.data.accepted !== true || sent.data.turnId !== turnId) throw new Error('SEND_UNCONFIRMED');
      this.emitMonitor('turn.accepted', undefined, turnId);
      return { accepted: true, sessionId: this.sessionId, turnId };
    } catch (error) {
      // The provider may or may not have started the turn: never resend, never clear the turn id.
      turn.callbackState = 'unknown';
      this.emitMonitor('turn.send-unconfirmed', () => ({ transportCode: transportCodeOf(error) ?? null }), turnId);
      this.markFaulted();
      throw new PedelecError('OUTCOME_UNKNOWN', 'send was not confirmed; the turn outcome is unknown', transportCodeOf(error), error);
    }
  }

  async cancel(reason: string): Promise<{ accepted: true; sessionId: string }> {
    assertReason(reason);
    const turn = this.turn;
    if (!turn || this.status === 'ended') throw new PedelecError('NO_ACTIVE_TURN', 'there is no active turn to cancel');
    turn.cancelRequested = true;
    await this.cliEndpoint?.close().catch(() => undefined);
    this.emitMonitor('turn.cancel-requested', () => ({ requested: true }), turn.turnId);
    turn.controller.abort();
    if (turn.callbackState === 'running') turn.callbackState = 'unknown';
    this.setStatus('outcome-unknown');
    try {
      await this.connection.cancel({ requestId: randomUUID(), sessionId: this.sessionId, reason }, { timeoutMs: this.sendTimeoutMs });
    } catch { /* Cancel delivery is unknown; the session already stays outcome-unknown. */ }
    // Not every provider reports a terminal after a stop. Every turn still ends exactly once.
    setTimeout(() => { if (this.turn === turn) this.queueTurnClosure(turn); }, CANCEL_TERMINAL_GRACE_MS).unref?.();
    return { accepted: true, sessionId: this.sessionId };
  }

  /** Ends the provider session and its worker. Idempotent; no event is dispatched afterwards. */
  async close(reason: string): Promise<{ accepted: true; sessionId: string }> {
    assertReason(reason);
    if (this.disposed || (this.status === 'ended' && this.listeners.length === 0)) {
      return { accepted: true, sessionId: this.sessionId };
    }
    const confirmedEnded = this.status === 'ended' && this.resumeAfterEnded;
    this.resumeAfterEnded = (this.status === 'idle' || confirmedEnded)
      && this.turn === null && !this.faulted && !this.faultPending;
    this.disposed = true;
    this.turn?.controller.abort();
    await this.trackStop(async () => {
      await this.cliEndpoint?.close().catch(() => undefined);
      this.setStatus('ended');
      this.trace.streamLost('SESSION_CLOSED', this.turn?.turnId ?? null);
      try {
        const reply = await this.connection.closeSession({ requestId: randomUUID(), sessionId: this.sessionId, reason }, { timeoutMs: CLOSE_TIMEOUT_MS });
        if (!isRecord(reply.data) || (reply.data.closed !== true && reply.data.accepted !== true)) throw new Error('CLOSE_UNCONFIRMED');
      } catch { this.resumeAfterEnded = this.resumeAfterEnded && confirmedEnded; }
      await this.stopWorker();
      if (this.connection.closed === false) this.resumeAfterEnded = false;
      await this.artifactStore?.cleanup(this.connection.closed !== false);
      await this.emitEnded('closed');
      this.release();
    });
    return { accepted: true, sessionId: this.sessionId };
  }

  /**
   * Stops the worker without a close-session frame and retires this object for good: no later resume, Attach or
   * eviction race can bring it back. The Provider Session itself is untouched.
   */
  async dispose(): Promise<void> {
    this.retired = true;
    this.resumeAfterEnded = false;
    if (this.disposed && this.listeners.length > 0) return; // A close already in progress releases the handle.
    if (this.listeners.length === 0) {
      this.disposed = true;
      this.status = 'ended';
      this.onDisposed(this.sessionId);
      return;
    }
    this.disposed = true;
    this.turn?.controller.abort();
    await this.trackStop(async () => {
      await this.cliEndpoint?.close().catch(() => undefined);
      this.setStatus('ended');
      this.trace.streamLost('SESSION_CLOSED', this.turn?.turnId ?? null);
      await this.stopWorker();
      await this.artifactStore?.cleanup(this.connection.closed !== false);
      await this.emitEnded('closed');
      this.release();
    });
  }

  private trackStop(work: () => Promise<void>): Promise<void> {
    const stopping: Promise<void> = work().finally(() => { if (this.stopping === stopping) this.stopping = null; });
    this.stopping = stopping;
    return stopping;
  }

  private async emitEnded(reason: PedelecEndedReason['reason'], turnId?: string | null): Promise<void> {
    if (this.endedReported) return;
    this.endedReported = true;
    this.emitMonitor('session.ended', () => ({ reason }), turnId);
    const ended = { reason, at: new Date().toISOString() };
    this.emitSdk('onEnded', () => ({ reason: ended, context: this.context(turnId), listenerCount: this.ended.size }), turnId ?? null);
    try { await this.afterEnded?.(); } catch { /* Maintenance may not change the provider lifecycle result. */ }
    await this.ended.emit(ended, this.context(turnId));
  }

  /** Observes SDK callback emissions independent of Host subscriptions; a listener never controls the SDK. */
  private emitSdk(name: string, data?: () => unknown, turnId: string | null = this.turn?.turnId ?? null): void {
    if (!this.detailedMonitoring) return;
    try { this.observe({ kind: `sdk.${name}`, sessionId: this.sessionId, turnId, data }); }
    catch { /* Monitoring never reaches the callback path. */ }
  }

  /** Called on the session's own control path, so it must stay synchronous, cheap and unable to throw. */
  private emitMonitor(kind: MonitorInput['kind'], data?: () => unknown, turnId: string | null = this.turn?.turnId ?? null): void {
    try { this.observe({ kind, sessionId: this.sessionId, turnId, data }); }
    catch { /* An observer never reaches the agent path. */ }
  }

  /** Per-frame facts only; delta frames are reported by their semantic event instead of twice. */
  private observeFrame(event: TransportEvent): void {
    const { kind, sequence, data } = event;
    // Provider RPC has its own traffic record; do not duplicate it as a synthetic transport event.
    if (this.detailedMonitoring && kind !== 'provider-rpc') this.emitMonitor('transport.event', () => ({ kind, sequence: sequence ?? null, data, droppedByFault: this.faulted }));
    if (kind === 'usage' || kind === 'provider-rpc' || (kind === 'turn' && isRecord(data) && data.type === 'assistant-delta')) return;
    this.emitMonitor('transport.frame', () => ({ kind, sequence: sequence ?? null, type: isRecord(data) ? data.type ?? null : null, droppedByFault: this.faulted }));
  }

  private async stopWorker(): Promise<void> {
    try { await this.connection.shutdown({ graceMs: 250, timeoutMs: CLOSE_TIMEOUT_MS }); }
    catch { await this.connection.terminate({ graceMs: 100 }).catch(() => undefined); }
    this.workerStopAttempted = true;
  }

  private release(): void {
    for (const [event, listener] of this.listeners) this.connection.removeListener?.(event, listener);
    for (const set of [this.chat, this.chatDelta, this.artifactLanded, this.statusListeners, this.errors, this.turnEnded, this.ended]) set.clear();
    this.trace.release();
    this.toolHandlers.clear();
    this.listeners = [];
    this.onDisposed(this.sessionId);
  }

  private context(turnId: string | null = this.turn?.turnId ?? null): PedelecSessionContext {
    return Object.freeze({
      sessionId: this.sessionId, provider: this.provider, turnId,
      eventEmittedAt: new Date().toISOString(),
    });
  }

  private setStatus(next: PedelecSessionStatus): void {
    if (this.status === next || (this.status === 'ended' && next !== 'ended' && !this.reactivating)) return;
    if (this.faulted && (next === 'idle' || next === 'busy')) return;
    const previous = this.status;
    this.status = next;
    this.emitMonitor('session.status', () => ({ status: next, previous, faulted: this.faulted }));
    this.emitSdk('onStatus', () => ({ status: next, context: this.context(), listenerCount: this.statusListeners.size }));
    void this.statusListeners.emit(next, this.context());
  }

  /** Latches the fault and stops the worker. True only for the first fault, which alone is reported. */
  private markFaulted(traceReason: 'WORKER_CRASHED' | 'TRANSPORT_FAILURE' | 'SESSION_FAULTED' = 'SESSION_FAULTED'): boolean {
    if (this.status === 'ended' || this.faulted) return false;
    this.faulted = true;
    const faultTurnId = this.turn?.turnId ?? null;
    void this.cliEndpoint?.close().catch(() => undefined);
    this.emitMonitor('session.faulted');
    if (this.turn) {
      if (this.turn.callbackState === 'running') this.turn.callbackState = 'unknown';
      this.turn.controller.abort();
    }
    this.setStatus(this.turn || this.status === 'outcome-unknown' ? 'outcome-unknown' : 'unavailable');
    const stopped = this.connection.terminate({ graceMs: 100 }).catch(() => undefined).then(() => { this.workerStopAttempted = true; });
    // Queued, so frames already received are drained first and a turn ends only once.
    this.eventQueue = this.eventQueue.then(async () => {
      // Observations received before the fault were drained first; the loss is reported once, no Tool is closed.
      this.trace.streamLost(traceReason, faultTurnId);
      if (this.turn) await this.handleTerminal({ code: 'SESSION_FAULTED' });
      await stopped;
      await this.artifactStore?.cleanup(false);
      if (this.disposed || this.status === 'ended') return;
      await this.emitEnded('worker-exited', null);
      // The slot frees here; the object still answers status queries and a later close().
      this.onDisposed(this.sessionId);
    }).catch(() => undefined);
    return true;
  }

  /** Ends a turn no provider terminal will ever close, after anything already queued. */
  private queueTurnClosure(turn: ActiveTurn): void {
    this.eventQueue = this.eventQueue.then(async () => {
      if (this.turn === turn) await this.handleTerminal({ code: 'TERMINAL_NOT_RECEIVED' });
    }).catch(() => { this.markFaulted(); });
  }

  private async reportError(category: PedelecErrorCategory, turnId: string | null): Promise<void> {
    this.emitMonitor('error.reported', () => ({ category, message: ERROR_MESSAGES[category] }), turnId);
    const error = Object.freeze({ category, message: ERROR_MESSAGES[category], turnId });
    this.emitSdk('onError', () => ({ error, context: this.context(turnId), listenerCount: this.errors.size }), turnId);
    await this.errors.emit(error, this.context(turnId));
  }

  private async handleWorkerLoss(category: 'WORKER_CRASHED' | 'TRANSPORT_FAILURE'): Promise<void> {
    if (this.disposed || this.status === 'ended') return;
    const turnId = this.turn?.turnId ?? null;
    if (this.markFaulted(category)) await this.reportError(category, turnId);
  }

  private async handleEvent(event: TransportEvent): Promise<void> {
    if (this.disposed || this.status === 'ended' || event.sessionId !== this.sessionId || !isRecord(event.data)) return;
    if (this.faulted) {
      // Only closes the turn as unknown. Queued or late frames are never consumed as valid work.
      if (event.kind === 'terminal') await this.handleTerminal(event.data);
      // A tool observation received before the fault is still a fact; it runs nothing.
      else if (event.kind === 'agent-tool') this.trace.ingestNative(event.data);
      return;
    }
    if (event.sequence !== undefined) {
      if (typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence <= this.lastSequence) {
        if (this.markFaulted()) await this.reportError('EVENT_SEQUENCE_REVERSED', this.turn?.turnId ?? null);
        return;
      }
      this.lastSequence = event.sequence;
    }
    const data = event.data;
    switch (event.kind) {
      case 'turn': await this.handleTurnEvent(data, event.sequence); return;
      case 'tool-request':
        if (this.cliOnly) { this.markFaulted(); return; }
        await this.handleToolRequest(data); return;
      case 'terminal': await this.handleTerminal(data); return;
      case 'artifact': await this.handleArtifact(data); return;
      case 'artifact-failed': await this.handleArtifactFailure(data); return;
      case 'provider-error':
      case 'crash':
        if (this.markFaulted()) await this.reportError('PROVIDER_ERROR', this.turn?.turnId ?? null);
        return;
      case 'agent-tool':
        // Synchronous and side-path only: bound, normalise and queue for listeners; never awaited.
        this.trace.ingestNative(data);
        return;
      case 'usage':
        this.emitMonitor('provider.usage', () => data);
        return;
      case 'provider-rpc':
        this.emitMonitor('provider.rpc', () => {
          if (this.detailedMonitoring) return data;
          const { payload: _payload, ...metadata } = data;
          return metadata;
        });
        return;
      default:
        return;
    }
  }

  /**
   * Runs in event order, so a Turn's files land before its terminal is reported. An artifact may follow its Turn's end
   * and may belong to a failed one; only a Turn this Session never ran is refused. Nothing here can fault the Session.
   */
  private async handleArtifact(data: Record<string, unknown>): Promise<void> {
    const { turnId } = data;
    if (typeof turnId !== 'string' || !this.turnIds.has(turnId) || !this.artifactStore) {
      await this.artifactStore?.discard(data.stagedPath);
      await this.reportArtifactFailure('ARTIFACT_INVALID', this.turn?.turnId ?? null);
      return;
    }
    const providerId = data.providerArtifactId ?? data.toolCallId;
    const key = typeof providerId === 'string' ? JSON.stringify([turnId, providerId, data.sha256]) : null;
    if (key !== null && this.artifactKeys.has(key)) {
      await this.artifactStore.discard(data.stagedPath);
      return;
    }
    let artifact: PedelecArtifact;
    try { artifact = await this.artifactStore.land(data); }
    catch {
      await this.artifactStore.discard(data.stagedPath);
      await this.reportArtifactFailure('ARTIFACT_STORAGE_FAILED', turnId);
      return;
    }
    if (key !== null) {
      if (this.artifactKeys.size >= MAX_ARTIFACT_KEYS) this.artifactKeys.clear();
      this.artifactKeys.add(key);
    }
    this.emitMonitor('turn.artifact', () => ({ kind: artifact.kind, source: artifact.source, mimeType: artifact.mimeType, bytes: artifact.sizeBytes }), turnId);
    const context: PedelecArtifactContext = Object.freeze({ ...this.context(turnId), turnId });
    this.emitSdk('onArtifact', () => ({ artifact, context, listenerCount: this.artifactLanded.size }), turnId);
    if (await this.artifactLanded.emit(artifact, context) > 0) await this.reportError('ARTIFACT_HANDLER_FAILED', turnId);
  }

  private async handleArtifactFailure(data: Record<string, unknown>): Promise<void> {
    const { turnId, code } = data;
    const known = typeof turnId === 'string' && this.turnIds.has(turnId);
    await this.reportArtifactFailure(typeof code === 'string' && ARTIFACT_FAILURE_CODE.test(code) ? code : 'ARTIFACT_STORAGE_FAILED', known ? turnId : this.turn?.turnId ?? null);
  }

  /** A delivery failure, never a Tool effect: nothing is retried and no Turn outcome changes. */
  private async reportArtifactFailure(code: string, turnId: string | null): Promise<void> {
    this.emitMonitor('turn.artifact-failed', () => ({ code }), turnId);
    await this.reportError('ARTIFACT_STORAGE_FAILED', turnId);
  }

  /** The SDK, not each provider module, decides whether a frame belongs to the active turn. */
  private async rejectForeignTurn(data: Record<string, unknown>): Promise<boolean> {
    if (typeof data.turnId !== 'string' || data.turnId === this.turn?.turnId) return false;
    if (this.markFaulted()) await this.reportError('PROVIDER_ERROR', this.turn?.turnId ?? null);
    return true;
  }

  private async handleTurnEvent(data: Record<string, unknown>, sequence: unknown): Promise<void> {
    if (await this.rejectForeignTurn(data)) return;
    const turn = this.turn;
    if (turn && data.type === 'started') this.emitMonitor('turn.started', () => ({ providerTurnId: data.providerTurnId ?? null, sequence: sequence ?? null }), turn.turnId);
    if (!turn || typeof data.text !== 'string') return;
    if (data.truncated === true) turn.truncated = true;
    if (data.type === 'assistant-delta') {
      turn.assistantText += data.text;
      this.emitMonitor('turn.assistant-delta', () => ({ bytes: typeof data.text === 'string' ? Buffer.byteLength(data.text) : 0, sequence: sequence ?? null }), turn.turnId);
      // The SDK emits deltas even without a registered Host listener. Observe that emission
      // independently, and report subscriber count so the viewer does not imply delivery.
      this.emitSdk('onChatDelta', () => ({
        text: data.text, context: this.chatContext(turn), listenerCount: this.chatDelta.size,
      }), turn.turnId);
      await this.chatDelta.emit(data.text, this.chatContext(turn));
    } else if (data.type === 'assistant-message') {
      turn.finalAssistantText = data.text;
      this.emitMonitor('turn.assistant-message', () => ({ bytes: typeof data.text === 'string' ? Buffer.byteLength(data.text) : 0, truncated: turn.truncated, sequence: sequence ?? null }), turn.turnId);
    }
  }

  private chatContext(turn: ActiveTurn): PedelecChatContext {
    return Object.freeze({ ...this.context(turn.turnId), turnId: turn.turnId, truncated: turn.truncated });
  }

  private async rejectToolRequest(turn: ActiveTurn | null): Promise<void> {
    if (!turn) return;
    turn.callbackState = 'unknown';
    this.emitMonitor('tool.rejected', undefined, turn.turnId);
    // The provider is waiting on a reply it will never get, so it has to stop.
    if (this.markFaulted()) await this.reportError('TOOL_REQUEST_REJECTED', turn.turnId);
  }

  private async handleToolRequest(data: Record<string, unknown>, deliver?: (reply: CliReply) => Promise<void>): Promise<void> {
    const turn = this.turn;
    const { turnId, toolCallId, toolName } = data;
    if (this.faulted) return;
    this.emitMonitor('tool.request', () => ({ toolCallId, toolName }));
    // Observation of a refused request; the refusal itself is unchanged.
    const traceRejected = () => this.trace.hostRefused({
      turnId: turn && turnId === turn.turnId ? turn.turnId : null,
      hostToolCallId: isSafeId(toolCallId) ? toolCallId : 'unavailable',
      toolName: typeof toolName === 'string' && toolName ? toolName.slice(0, 128) : 'unknown',
      args: data.args, status: 'denied', errorCode: 'TOOL_REQUEST_REJECTED',
    });
    if (!turn || turnId !== turn.turnId || !isSafeId(toolCallId) || typeof toolName !== 'string'
      || this.status !== 'busy' || turn.cancelRequested || turn.callbackState !== 'none') {
      traceRejected();
      await this.rejectToolRequest(turn);
      return;
    }
    const callbackKey = JSON.stringify([this.sessionId, turnId, toolCallId]);
    const handler = this.toolHandlers.get(toolName);
    if (this.callbackKeys.has(callbackKey) || !handler || !this.tools.some((tool) => tool.name === toolName)) {
      traceRejected();
      await this.rejectToolRequest(turn);
      return;
    }
    this.callbackKeys.add(callbackKey);
    const call: ToolCall = { toolCallId, toolName, state: 'running' };
    turn.toolCalls.push(call);
    turn.callbackState = 'running';
    const stillActive = () => !this.disposed && !this.faulted && !this.faultPending && this.status === 'busy' && this.turn === turn
      && !turn.cancelRequested && turn.callbackState === 'running' && call.state === 'running' && turn.toolCalls.at(-1) === call;
    const context: PedelecToolContext = Object.freeze({
      sessionId: this.sessionId, turnId: turn.turnId, toolCallId, toolName,
      signal: turn.controller.signal,
      assertActive: () => { if (!stillActive()) throw new PedelecError('SESSION_NOT_ACTIVE', 'tool callback is no longer active'); },
    });

    const traceContext = this.trace.hostStarted({ turnId: turn.turnId, hostToolCallId: toolCallId, toolName, args: data.args });
    // Handler outcome, once known, kept apart from delivery: a returned result is not a Provider-received result.
    let handlerOutcome: Readonly<Record<string, unknown>> | undefined;
    const fail = async (category: PedelecErrorCategory, traceStatus: AgentToolStatus = 'unknown', traceCode: string = category) => {
      this.trace.hostFinished(traceContext, {
        status: traceStatus, errorCode: traceCode,
        ...(handlerOutcome ? { output: { ...handlerOutcome, delivery: 'unconfirmed', providerAcknowledgement: 'unavailable' } } : {}),
      });
      this.emitSdk('onTool.error', () => ({ toolCallId, toolName, category }), turn.turnId);
      this.emitMonitor('tool.failed', () => ({ toolCallId, toolName, category, state: 'unknown' }), turn.turnId);
      call.state = 'unknown';
      if (turn.callbackState === 'running' || turn.callbackState === 'none') turn.callbackState = 'unknown';
      // Fail-closed includes stopping the provider; only the first fault is reported.
      if (this.markFaulted()) await this.reportError(category, turn.turnId);
    };

    let reply: unknown;
    this.emitMonitor('tool.handler-started', () => ({ toolCallId, toolName }), turn.turnId);
    this.emitSdk('onTool', () => ({ toolName, args: data.args, context: { sessionId: this.sessionId, turnId: turn.turnId, toolCallId, toolName } }), turn.turnId);
    try {
      if (deliver) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopped = () => rejectStopped?.(new Error('TOOL_ABORTED'));
        let rejectStopped: ((reason: Error) => void) | undefined;
        try {
          reply = await Promise.race([
            Promise.resolve().then(() => { context.assertActive(); return handler(data.args, context); }),
            new Promise<never>((_, reject) => {
              rejectStopped = reject;
              timer = setTimeout(() => reject(new Error('TOOL_TIMEOUT')), this.toolReplyTimeoutMs);
              turn.controller.signal.addEventListener('abort', stopped, { once: true });
            }),
          ]);
        } finally { clearTimeout(timer); turn.controller.signal.removeEventListener('abort', stopped); }
      } else reply = await handler(data.args, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'TOOL_TIMEOUT') await fail('TOOL_HANDLER_FAILED', 'unknown', 'TOOL_TIMEOUT');
      else if (reason === 'TOOL_ABORTED') await fail('TOOL_HANDLER_FAILED', 'cancelled', 'TOOL_ABORTED');
      else if (error instanceof PedelecError && error.code === 'SESSION_NOT_ACTIVE') await fail('TOOL_HANDLER_FAILED', 'unknown', 'TOOL_NO_LONGER_ACTIVE');
      else await fail('TOOL_HANDLER_FAILED', 'failed', 'TOOL_HANDLER_FAILED');
      return;
    }
    if (isRecord(reply)) {
      handlerOutcome = { handler: 'returned', success: reply.success === true, result: reply.result };
      this.trace.hostUpdated(traceContext, handlerOutcome);
    }
    this.emitMonitor('tool.handler-finished', () => ({ toolCallId, toolName, success: isRecord(reply) && reply.success === true }), turn.turnId);
    this.emitSdk('onTool.result', () => ({ toolCallId, toolName, reply }), turn.turnId);
    // A fault, cancel, close or turn change during the handler means the effect may exist but must not be ACKed.
    if (!stillActive()) { await fail('TOOL_HANDLER_FAILED', 'unknown', 'TOOL_NO_LONGER_ACTIVE'); return; }
    if (!isRecord(reply) || typeof reply.success !== 'boolean' || !Object.hasOwn(reply, 'result')) { await fail('TOOL_RESULT_INVALID', 'failed'); return; }
    const result = boundedJson(reply.result);
    if (result === undefined) { await fail('TOOL_RESULT_INVALID', 'failed'); return; }
    if (turn.replyAttempted) { await fail('TOOL_ACK_UNKNOWN'); return; }
    turn.replyAttempted = true;
    this.emitMonitor('tool.reply-attempted', () => ({ toolCallId, toolName, success: isRecord(reply) && reply.success === true }), turn.turnId);
    try {
      const success = reply.success;
      if (deliver) {
        // Confirmation here is completion of the CLI socket write, never a provider-native ACK.
        await deliver(success === true ? { ok: true, result } : { ...cliError('TOOL_FAILED'), result });
      } else {
        const ack = await this.connection.toolReply(
          { requestId: randomUUID(), sessionId: this.sessionId, turnId: turn.turnId, toolCallId, success, result },
          { timeoutMs: this.toolReplyTimeoutMs },
        );
        if (!isRecord(ack.data) || ack.data.acknowledged !== true || ack.data.turnId !== turn.turnId || ack.data.toolCallId !== toolCallId) {
          await fail('TOOL_ACK_UNKNOWN');
          return;
        }
      }
      // An ACK that lands after a fault or cancel cannot clear the unknown already recorded for this call.
      if (!stillActive()) { await fail('TOOL_ACK_UNKNOWN'); return; }
      call.state = 'acknowledged';
      this.trace.hostFinished(traceContext, {
        status: success ? 'completed' : 'failed', ...(success ? {} : { errorCode: 'TOOL_REPORTED_FAILURE' }),
        output: deliver
          ? { success, result, delivery: 'cli-reply-written', providerAcknowledgement: 'unavailable' }
          : { success, result, delivery: 'transport-acknowledged', providerAcknowledgement: 'acknowledged' },
      });
      // Each acknowledged tool completes its own request. The same Turn may invoke
      // another registered tool; toolCallId deduplication stays session-scoped.
      turn.replyAttempted = false;
      turn.callbackState = 'none';
      this.emitMonitor('tool.reply-acknowledged', () => ({ toolCallId, toolName }), turn.turnId);
    } catch {
      await fail('TOOL_ACK_UNKNOWN');
    }
  }

  private async handleTerminal(data: Record<string, unknown>): Promise<void> {
    if (await this.rejectForeignTurn(data)) return;
    const turn = this.turn;
    const providerStatus = typeof data.status === 'string' ? data.status : null;
    if (!turn) {
      if (providerStatus === 'closed' && !this.faulted) {
        // A prior unknown Turn cannot become recoverable merely because the Provider closed.
        this.resumeAfterEnded = this.status === 'idle';
        this.setStatus('ended');
        await this.emitEnded('provider-closed', null);
      }
      return;
    }
    this.emitMonitor('turn.terminal', () => ({ providerStatus, code: data.code ?? null }), turn.turnId);
    turn.controller.abort();
    this.turn = null;
    const clean = !this.faulted && !turn.cancelRequested && turn.callbackState !== 'unknown' && turn.callbackState !== 'running';
    let terminal: PedelecTurnTerminal = 'unknown';
    if (providerStatus === 'completed' && clean) terminal = 'completed';
    else if (providerStatus === 'failed' && clean) terminal = 'failed';
    else if (providerStatus === 'interrupted' && clean) terminal = 'interrupted';

    if (terminal === 'completed') {
      const text = turn.finalAssistantText ?? turn.assistantText;
      this.emitSdk('onChat', () => ({ text, context: this.chatContext(turn), listenerCount: this.chat.size }), turn.turnId);
      const failures = await this.chat.emit(text, this.chatContext(turn));
      if (failures > 0) {
        terminal = 'unknown';
        this.setStatus('outcome-unknown');
        await this.reportError('CHAT_HANDLER_FAILED', turn.turnId);
      } else {
        this.setStatus('idle');
      }
    } else {
      this.setStatus('outcome-unknown');
    }
    const outcome: PedelecTurnOutcome = Object.freeze({
      turnId: turn.turnId, terminal, providerStatus, cancelRequested: turn.cancelRequested,
      toolCalls: Object.freeze(turn.toolCalls.map((call) => Object.freeze({ ...call }))),
    });
    this.emitMonitor('turn.ended', () => outcome, turn.turnId);
    this.emitSdk('onTurnEnded', () => ({ outcome, context: this.context(turn.turnId), listenerCount: this.turnEnded.size }), turn.turnId);
    await this.turnEnded.emit(outcome, this.context(turn.turnId));
  }
}
