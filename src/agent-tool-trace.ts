/**
 * Level 1 Agent Tool Trace: SDK-side event-first normaliser, size bounds and bounded listener dispatch.
 *
 * Contract (01A): every Worker observation and every Host Tool fact becomes one event, in arrival order. The SDK keeps
 * no Tool Record map: it does not dedupe, does not infer missing phases, and never synthesises a `finished`/`unknown`
 * at Turn end, cancel, close or crash. Values are not redacted (trusted Server consumer); only truncation applies.
 *
 * Everything here is a side path. Session code calls only synchronous, non-throwing methods; listeners run later on
 * their own bounded queues, so no Tool, ACK, Turn or Worker path ever waits on, or is changed by, an observer.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentToolCoverage, AgentToolEvent, AgentToolEventKind, AgentToolEventListener, AgentToolEventSource,
  AgentToolHostInvocation, AgentToolKind, AgentToolStatus, AgentToolUnavailableField, JsonValue, PedelecProvider, Unsubscribe,
} from './types.ts';

/* ------------------------------------------------------------------ limits ------------------------------------------------------------------ */

/** Locked by tests; see README "Agent Tool Trace". Resource protection only, not a data-safety filter. */
export const AGENT_TOOL_TRACE_LIMITS = Object.freeze({
  /** Pending events per listener before new ones are counted into an `observation-gap`. */
  queuePerListener: 256,
  /** A listener promise is no longer awaited after this; the next event proceeds. */
  listenerTimeoutMs: 10_000,
  commandBytes: 4 * 1024,
  stdoutBytes: 8 * 1024,
  stderrBytes: 8 * 1024,
  stringBytes: 4 * 1024,
  inputBytes: 16 * 1024,
  /** Room for stdout and stderr at their own limits plus truncation markers. */
  outputBytes: 24 * 1024,
  eventBytes: 64 * 1024,
  maxDepth: 6,
  maxEntries: 64,
  /** Max length of a Provider/Host id accepted into an event. */
  idChars: 256,
});

const KINDS = new Set<AgentToolKind>(['shell', 'file', 'browser', 'search', 'mcp', 'host', 'other', 'unknown']);
const STATUSES = new Set<AgentToolStatus>(['running', 'completed', 'failed', 'denied', 'cancelled', 'unknown']);
const COVERAGES = new Set<AgentToolCoverage>(['supported', 'partial', 'unsupported', 'unknown']);
const UNAVAILABLE = new Set<AgentToolUnavailableField>(['turnId', 'nativeToolCallId', 'toolName', 'input', 'output', 'stdout', 'stderr', 'exitCode']);
const CODE = /^[A-Z0-9_]{1,64}$/;

export function parseCoverage(value: unknown): AgentToolCoverage {
  return typeof value === 'string' && COVERAGES.has(value as AgentToolCoverage) ? value as AgentToolCoverage : 'unknown';
}

/* ----------------------------------------------------------------- bounds ----------------------------------------------------------------- */

type BoundState = { truncated: boolean };

/**
 * Size bounds only: strings, depth, entries and whole sections are capped and every cut is marked. Values (tokens,
 * credentials, private paths, URLs) are kept verbatim; consumers own ACL, redaction for display, retention.
 */
export class TraceBounds {
  text(value: string, limitBytes: number, state: BoundState): string {
    return truncateBytes(value, limitBytes, state);
  }

  value(value: unknown, state: BoundState, key = '', depth = 0): JsonValue {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return this.text(value, fieldLimit(key), state);
    if (typeof value !== 'object') return null;
    if (depth >= AGENT_TOOL_TRACE_LIMITS.maxDepth) { state.truncated = true; return '[max-depth]'; }
    const { maxEntries } = AGENT_TOOL_TRACE_LIMITS;
    if (Array.isArray(value)) {
      if (value.length > maxEntries) state.truncated = true;
      return value.slice(0, maxEntries).map((item) => this.value(item, state, key, depth + 1));
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > maxEntries) state.truncated = true;
    const copy: Record<string, JsonValue> = {};
    for (const [name, item] of entries.slice(0, maxEntries)) {
      if (item === undefined) continue;
      copy[name] = this.value(item, state, name, depth + 1);
    }
    return copy;
  }

  /** Bounds then enforces a whole-section byte budget; an oversized section keeps only an explicit preview. */
  section(value: unknown, budget: number, state: BoundState): JsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    const clean = this.value(value, state);
    const size = byteLength(JSON.stringify(clean));
    if (size <= budget) return clean;
    state.truncated = true;
    return { preview: truncateBytes(JSON.stringify(clean), Math.max(256, budget - 256), state), truncated: true };
  }
}

function fieldLimit(key: string): number {
  const { commandBytes, stdoutBytes, stderrBytes, stringBytes } = AGENT_TOOL_TRACE_LIMITS;
  if (key === 'command' || key === 'cmd') return commandBytes;
  if (key === 'stderr') return stderrBytes;
  if (key === 'stdout' || key === 'output' || key === 'aggregatedOutput') return stdoutBytes;
  return stringBytes;
}

function byteLength(text: string | undefined): number {
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

function truncateBytes(text: string, limit: number, state: BoundState): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  state.truncated = true;
  let kept = bytes.subarray(0, limit).toString('utf8');
  // Drop a split trailing code point (decoded as U+FFFD).
  if (kept.endsWith('\uFFFD')) kept = kept.slice(0, -1);
  return `${kept}…[truncated ${bytes.length - byteLength(kept)} bytes]`;
}

/* ------------------------------------------------------------- pedelec-cli parsing ------------------------------------------------------------- */

export type CliInvocation = { subcommand: 'tool-call' | 'tool-spec'; toolName: string; threadId: string | null; args: string | null };

/** POSIX-like word split with quotes, escapes and control operators as separators. Never executes or expands. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      word += end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end < 0 ? text.length : end;
      inWord = true;
    } else if (ch === '"') {
      inWord = true;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) i += 1;
        word += text[i];
      }
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[i + 1]; i += 1; inWord = true;
    } else if (/\s/.test(ch) || ';&|()`<>'.includes(ch)) {
      if (inWord) { words.push(word); word = ''; inWord = false; }
    } else {
      word += ch; inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** Every `pedelec-cli` call written in a Shell command, including inside `sh -c '<script>'`. */
export function parseCliInvocations(command: string, depth = 0): CliInvocation[] {
  if (depth > 3 || !command.includes('pedelec-cli')) return [];
  const words = shellWords(command);
  const found: CliInvocation[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const base = word.split(/[\\/]/).pop()!;
    if (base !== 'pedelec-cli' && base !== 'pedelec-cli.exe') {
      if (word.includes('pedelec-cli') && /\s/.test(word)) found.push(...parseCliInvocations(word, depth + 1));
      continue;
    }
    let threadId: string | null = null;
    let j = i + 1;
    while (j < words.length && words[j]!.startsWith('-')) {
      const flag = words[j]!;
      if (flag === '--thread-id' && j + 1 < words.length) { threadId = words[j + 1]!; j += 2; continue; }
      if (flag.startsWith('--thread-id=')) { threadId = flag.slice('--thread-id='.length); j += 1; continue; }
      j += 1;
    }
    const subcommand = words[j];
    const toolName = words[j + 1];
    if ((subcommand === 'tool-call' || subcommand === 'tool-spec') && toolName && /^[A-Za-z][A-Za-z0-9_-]*$/.test(toolName)) {
      found.push({ subcommand, toolName, threadId, args: subcommand === 'tool-call' ? words[j + 2] ?? null : null });
      i = j + 1;
    }
  }
  return found;
}

/* ---------------------------------------------------------------- dispatcher ---------------------------------------------------------------- */

type Subscriber = {
  readonly listener: AgentToolEventListener;
  readonly queue: AgentToolEvent[];
  dropped: number;
  firstDropped: number;
  lastDropped: number;
  running: boolean;
  active: boolean;
  /** Set on Session release: delivers what is already queued, then leaves. */
  retiring: boolean;
};

export type DispatcherStats = { listenerFailures: number; listenerTimeouts: number; dropped: number };

/**
 * One bounded queue per listener, so a slow or failing listener can only lose its own events, which it is then told
 * about in order. `publish` is synchronous and never throws; every listener call happens on a later microtask.
 */
export class AgentToolDispatcher {
  private readonly subscribers = new Set<Subscriber>();
  readonly stats: DispatcherStats = { listenerFailures: 0, listenerTimeouts: 0, dropped: 0 };
  private readonly gapFor: (dropped: number, first: number, last: number) => AgentToolEvent;

  constructor(gapFor: (dropped: number, first: number, last: number) => AgentToolEvent) {
    this.gapFor = gapFor;
  }

  get size(): number { return this.subscribers.size; }

  add(listener: AgentToolEventListener): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const subscriber: Subscriber = { listener, queue: [], dropped: 0, firstDropped: 0, lastDropped: 0, running: false, active: true, retiring: false };
    this.subscribers.add(subscriber);
    return () => {
      subscriber.active = false;
      subscriber.queue.length = 0;
      this.subscribers.delete(subscriber);
    };
  }

  publish(event: AgentToolEvent): void {
    for (const subscriber of this.subscribers) {
      if (!subscriber.active || subscriber.retiring) continue;
      try { this.enqueue(subscriber, event); } catch { /* Never reaches the Session. */ }
    }
  }

  /** Lets current listeners receive what is queued, then detaches them. Later subscribers are unaffected. */
  retireAll(): void {
    for (const subscriber of this.subscribers) {
      subscriber.retiring = true;
      if (!subscriber.running && subscriber.queue.length === 0 && subscriber.dropped === 0) this.subscribers.delete(subscriber);
    }
  }

  private enqueue(subscriber: Subscriber, event: AgentToolEvent): void {
    const capacity = AGENT_TOOL_TRACE_LIMITS.queuePerListener;
    // A pending gap needs its own slot ahead of the event it precedes.
    const needed = subscriber.dropped > 0 ? 2 : 1;
    if (subscriber.queue.length + needed > capacity) {
      if (subscriber.dropped === 0) subscriber.firstDropped = event.sequence;
      subscriber.dropped += 1;
      subscriber.lastDropped = event.sequence;
      this.stats.dropped += 1;
    } else {
      this.flushGap(subscriber);
      subscriber.queue.push(event);
    }
    this.schedule(subscriber);
  }

  private flushGap(subscriber: Subscriber): void {
    if (subscriber.dropped === 0) return;
    subscriber.queue.push(this.gapFor(subscriber.dropped, subscriber.firstDropped, subscriber.lastDropped));
    subscriber.dropped = 0;
  }

  private schedule(subscriber: Subscriber): void {
    if (subscriber.running) return;
    subscriber.running = true;
    queueMicrotask(() => { void this.pump(subscriber); });
  }

  private async pump(subscriber: Subscriber): Promise<void> {
    try {
      while (subscriber.active) {
        if (subscriber.queue.length === 0) this.flushGap(subscriber);
        const event = subscriber.queue.shift();
        if (!event) break;
        await this.deliver(subscriber.listener, event);
      }
    } finally {
      subscriber.running = false;
      if (subscriber.retiring && subscriber.queue.length === 0 && subscriber.dropped === 0) this.subscribers.delete(subscriber);
      else if (subscriber.active && (subscriber.queue.length > 0 || subscriber.dropped > 0)) this.schedule(subscriber);
    }
  }

  private async deliver(listener: AgentToolEventListener, event: AgentToolEvent): Promise<void> {
    let result: unknown;
    try { result = listener(event); } catch { this.stats.listenerFailures += 1; return; }
    if (!result || typeof (result as Promise<void>).then !== 'function') return;
    const settled = Promise.resolve(result as Promise<void>).then(() => 'ok' as const, () => 'failed' as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), AGENT_TOOL_TRACE_LIMITS.listenerTimeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (outcome === 'failed') this.stats.listenerFailures += 1;
    if (outcome === 'timeout') this.stats.listenerTimeouts += 1;
  }
}

/* ---------------------------------------------------------------- normaliser ---------------------------------------------------------------- */

/** Invocation-local Host context: lives only for one `onTool` call; nothing is stored on the tracer. */
export type HostTraceContext = {
  readonly toolCallId: string;
  readonly turnId: string | null;
  readonly hostToolCallId: string;
  readonly toolName: string;
  finished: boolean;
};

export type HostTraceStart = { turnId: string | null; hostToolCallId: string; toolName: string; args: unknown };
export type HostTraceEnd = { status: AgentToolStatus; errorCode?: string; output?: unknown };

export type TracerInit = {
  sessionId: string;
  provider: PedelecProvider;
  coverage: AgentToolCoverage;
  /** True when this Session ran the Turn; a frame naming any other Turn is not trusted as its own. */
  knownTurn: (turnId: string) => boolean;
  /** The Turn currently running, if any; a known Turn that is not active marks the event `lateObservation`. */
  activeTurn: () => string | null;
};

/**
 * Deterministic identity for (Session, Turn, source, id): the same native/Host id in the same Turn always maps to the
 * same `toolCallId` without any lookup table; a different Session or Turn never does.
 */
export function stableToolCallId(source: AgentToolEventSource, sessionId: string, turnId: string, id: string): string {
  const prefix = source === 'provider-native' ? 'native' : 'host';
  return `${prefix}:${createHash('sha256').update(JSON.stringify([sessionId, turnId, source, id])).digest('hex').slice(0, 32)}`;
}

/**
 * Turns Worker observations and Host Tool facts into ordered, bounded, frozen events. Stateless per Tool: the only
 * fields kept are Session-level (sequence, coverage, stream-ended latch). Nothing a Provider did not report is invented.
 */
export class AgentToolTracer {
  readonly dispatcher: AgentToolDispatcher;
  private readonly init: TracerInit;
  private readonly bounds = new TraceBounds();
  private sequence = 0;
  private coverage: AgentToolCoverage;
  private streamEnded = false;

  constructor(init: TracerInit) {
    this.init = init;
    this.coverage = init.coverage;
    this.dispatcher = new AgentToolDispatcher((dropped, first, last) => this.freeze({
      kind: 'observation-gap', source: 'provider-native', toolCallId: `gap:${randomUUID()}`, turnId: null, toolName: 'unknown',
      toolKind: 'unknown', errorCode: 'LISTENER_QUEUE_OVERFLOW', coverage: 'partial', droppedEvents: dropped,
      droppedSequences: Object.freeze({ first, last }), sequence: last,
    }));
  }

  subscribe(listener: AgentToolEventListener): Unsubscribe { return this.dispatcher.add(listener); }

  /** Session (re)bound to a Worker: its receipt states the adapter coverage. */
  setCoverage(coverage: AgentToolCoverage): void { this.coverage = coverage; this.streamEnded = false; }

  /** A Turn whose Tools this Provider cannot (fully) report starts with that fact, so silence is never read as "no tools". */
  turnStarted(turnId: string): void {
    this.safely(() => {
      if (this.coverage === 'supported') return;
      this.gap(turnId, this.coverage === 'unsupported' ? 'PROVIDER_TRACE_UNSUPPORTED' : 'PROVIDER_TRACE_COVERAGE_UNKNOWN', this.coverage);
    });
  }

  /**
   * The trace stream was really interrupted (Worker crash, transport failure, fault, or close during a running Turn).
   * One bounded gap says so; no open Tool is closed or given an outcome. A close with no running Turn is not a loss.
   */
  streamLost(reason: 'WORKER_CRASHED' | 'TRANSPORT_FAILURE' | 'SESSION_FAULTED' | 'SESSION_CLOSED', turnId: string | null): void {
    this.safely(() => {
      if (this.streamEnded) return;
      this.streamEnded = true;
      if (reason === 'SESSION_CLOSED' && turnId === null) return;
      this.gap(turnId, 'TRACE_STREAM_ENDED', 'partial', { reason });
    });
  }

  /** Detaches current listeners after their queued events; the Session stays observable if it is resumed. */
  release(): void { this.dispatcher.retireAll(); }

  /* ----- provider-native (Worker `agent-tool` frames) ----- */

  ingestNative(data: Readonly<Record<string, unknown>>): void {
    this.safely(() => this.native(data));
  }

  private native(data: Readonly<Record<string, unknown>>): void {
    // After the stream ended (fault, crash, close) nothing more is trusted as an observation of this Session.
    if (this.streamEnded) return;
    const phase = data.phase;
    const reportedTurn = typeof data.turnId === 'string' ? data.turnId : null;
    const turnId = reportedTurn !== null && this.init.knownTurn(reportedTurn) ? reportedTurn : null;
    if (phase === 'gap') {
      const code = typeof data.errorCode === 'string' && CODE.test(data.errorCode) ? data.errorCode : 'PROVIDER_TRACE_GAP';
      const coverage = parseCoverage(data.coverage);
      const detail = isObject(data.detail) ? data.detail
        : typeof data.nativeToolCallId === 'string' ? { nativeToolCallId: data.nativeToolCallId } : undefined;
      this.gap(turnId, code, coverage === 'unknown' ? 'partial' : coverage, detail);
      return;
    }
    if (phase !== 'started' && phase !== 'updated' && phase !== 'finished') return;
    const { idChars } = AGENT_TOOL_TRACE_LIMITS;
    const nativeId = typeof data.nativeToolCallId === 'string' && data.nativeToolCallId && data.nativeToolCallId.length <= idChars ? data.nativeToolCallId : undefined;
    const toolName = typeof data.toolName === 'string' && data.toolName.trim() && data.toolName.length <= idChars ? data.toolName : 'unknown';
    const toolKind = typeof data.toolKind === 'string' && KINDS.has(data.toolKind as AgentToolKind) ? data.toolKind as AgentToolKind : 'unknown';
    const status = typeof data.status === 'string' && STATUSES.has(data.status as AgentToolStatus) ? data.status as AgentToolStatus : undefined;
    const exitCode = Number.isSafeInteger(data.exitCode) ? data.exitCode as number : undefined;
    const unavailable = new Set<AgentToolUnavailableField>(Array.isArray(data.unavailable)
      ? data.unavailable.filter((f): f is AgentToolUnavailableField => typeof f === 'string' && UNAVAILABLE.has(f as AgentToolUnavailableField)) : []);
    if (turnId === null) unavailable.add('turnId');
    if (nativeId === undefined) unavailable.add('nativeToolCallId');
    if (exitCode !== undefined) unavailable.delete('exitCode');
    if (toolName === 'unknown') unavailable.add('toolName'); else unavailable.delete('toolName');
    // Stable identity only with evidence (known Turn + native id); otherwise this event stands alone.
    const toolCallId = turnId !== null && nativeId !== undefined
      ? stableToolCallId('provider-native', this.init.sessionId, turnId, nativeId) : `native:${randomUUID()}`;
    const parentNative = typeof data.parentNativeToolCallId === 'string' && data.parentNativeToolCallId && data.parentNativeToolCallId.length <= idChars
      ? data.parentNativeToolCallId : undefined;
    const parentToolCallId = turnId !== null && parentNative !== undefined
      ? stableToolCallId('provider-native', this.init.sessionId, turnId, parentNative) : undefined;
    // Event-local hint: `pedelec-cli` calls written in this Shell command (not a proven parent link).
    const command = isObject(data.input) && typeof data.input.command === 'string' ? data.input.command
      : isObject(data.input) && isObject(data.input.rawInput) && typeof data.input.rawInput.command === 'string' ? data.input.rawInput.command
      : isObject(data.input) && typeof data.input.title === 'string' ? data.input.title : undefined;
    const hostInvocations = command !== undefined && toolKind === 'shell'
      ? parseCliInvocations(command).map((i) => Object.freeze({ subcommand: i.subcommand, toolName: i.toolName })) : [];
    const state: BoundState = { truncated: data.truncated === true };
    const input = this.bounds.section(data.input, AGENT_TOOL_TRACE_LIMITS.inputBytes, state);
    const output = this.bounds.section(data.output, AGENT_TOOL_TRACE_LIMITS.outputBytes, state);
    const errorCode = typeof data.errorCode === 'string' && CODE.test(data.errorCode) ? data.errorCode : undefined;
    const partial = nativeId === undefined || turnId === null || this.coverage !== 'supported';
    this.publish({
      kind: phase, source: 'provider-native', toolCallId, turnId, toolName, toolKind,
      nativeToolCallId: nativeId, parentToolCallId, hostInvocations,
      status, exitCode, input, output, errorCode, state,
      at: typeof data.at === 'string' && data.at.length <= 64 ? data.at : undefined,
      unavailable: [...unavailable],
      late: turnId !== null && this.init.activeTurn() !== turnId,
      coverage: partial ? 'partial' : 'supported',
    });
  }

  /* ----- pedelec-host (SDK onTool path; never changes it) ----- */

  /** Returns the invocation-local context for hostUpdated/hostFinished, or null if tracing failed (the Tool runs regardless). */
  hostStarted(input: HostTraceStart): HostTraceContext | null {
    return this.safely(() => {
      const context: HostTraceContext = {
        toolCallId: this.hostId(input.turnId, input.hostToolCallId), turnId: input.turnId,
        hostToolCallId: input.hostToolCallId, toolName: input.toolName, finished: false,
      };
      this.publishHost(context, 'started', { status: 'running', input: { args: input.args } });
      return context;
    }) ?? null;
  }

  hostUpdated(context: HostTraceContext | null, output: unknown): void {
    this.safely(() => {
      if (context && !context.finished) this.publishHost(context, 'updated', { status: 'running', output });
    });
  }

  hostFinished(context: HostTraceContext | null, end: HostTraceEnd): void {
    this.safely(() => {
      if (!context || context.finished) return;
      context.finished = true;
      this.publishHost(context, 'finished', end);
    });
  }

  /** A `tool-call` refused before any handler ran (invalid args, stale or inactive Turn, pending call, rejected frame). */
  hostRefused(input: HostTraceStart & { status: 'denied' | 'failed'; errorCode: string }): void {
    this.safely(() => {
      const context: HostTraceContext = {
        toolCallId: this.hostId(input.turnId, input.hostToolCallId), turnId: input.turnId,
        hostToolCallId: input.hostToolCallId, toolName: input.toolName, finished: true,
      };
      this.publishHost(context, 'finished', { status: input.status, errorCode: input.errorCode, input: { args: input.args } });
    });
  }

  private hostId(turnId: string | null, hostToolCallId: string): string {
    return turnId !== null && hostToolCallId !== 'unavailable' && hostToolCallId.length <= AGENT_TOOL_TRACE_LIMITS.idChars
      ? stableToolCallId('pedelec-host', this.init.sessionId, turnId, hostToolCallId) : `host:${randomUUID()}`;
  }

  /* ----- event construction ----- */

  private publishHost(context: HostTraceContext, kind: AgentToolEventKind, detail: { status?: AgentToolStatus; errorCode?: string; output?: unknown; input?: unknown }): void {
    const state: BoundState = { truncated: false };
    const input = this.bounds.section(detail.input, AGENT_TOOL_TRACE_LIMITS.inputBytes, state);
    const output = this.bounds.section(detail.output, AGENT_TOOL_TRACE_LIMITS.outputBytes, state);
    const errorCode = detail.errorCode !== undefined && CODE.test(detail.errorCode) ? detail.errorCode : undefined;
    this.publish({
      kind, source: 'pedelec-host', toolCallId: context.toolCallId, turnId: context.turnId, toolName: context.toolName, toolKind: 'host',
      hostToolCallId: context.hostToolCallId, correlation: 'unlinked',
      status: detail.status, input, output, errorCode, state, unavailable: context.turnId === null ? ['turnId'] : [], late: false,
      coverage: context.turnId === null ? 'partial' : 'supported',
    });
  }

  private publish(d: {
    kind: AgentToolEventKind; source: AgentToolEventSource; toolCallId: string; turnId: string | null; toolName: string; toolKind: AgentToolKind;
    nativeToolCallId?: string; parentToolCallId?: string; hostToolCallId?: string; correlation?: 'unlinked';
    hostInvocations?: readonly AgentToolHostInvocation[];
    status?: AgentToolStatus; exitCode?: number; input?: JsonValue; output?: JsonValue; errorCode?: string;
    state: BoundState; at?: string; unavailable: AgentToolUnavailableField[]; late: boolean; coverage: AgentToolCoverage;
  }): void {
    this.sequence += 1;
    const event: Record<string, unknown> = {
      kind: d.kind, source: d.source, toolCallId: d.toolCallId, turnId: d.turnId,
      toolName: d.toolName, toolKind: d.toolKind, sequence: this.sequence, coverage: d.coverage,
    };
    if (d.at) event.at = d.at;
    if (d.nativeToolCallId !== undefined) event.nativeToolCallId = d.nativeToolCallId;
    if (d.parentToolCallId !== undefined) event.parentToolCallId = d.parentToolCallId;
    if (d.hostToolCallId !== undefined) event.hostToolCallId = d.hostToolCallId;
    if (d.correlation !== undefined) event.correlation = d.correlation;
    if (d.hostInvocations?.length) event.hostInvocations = Object.freeze([...d.hostInvocations]);
    if (d.status !== undefined) event.status = d.status;
    if (d.exitCode !== undefined) event.exitCode = d.exitCode;
    if (d.input !== undefined) event.input = d.input;
    if (d.output !== undefined) event.output = d.output;
    if (d.errorCode !== undefined) event.errorCode = d.errorCode;
    if (d.unavailable.length) event.unavailable = Object.freeze([...new Set(d.unavailable)]);
    if (d.late) event.lateObservation = true;
    if (d.state.truncated) event.detailTruncated = true;
    // Whole-event budget: identity and outcome always survive.
    if (byteLength(JSON.stringify(event)) > AGENT_TOOL_TRACE_LIMITS.eventBytes) {
      if (event.input !== undefined) event.input = { omitted: true };
      if (event.output !== undefined) event.output = { omitted: true };
      event.detailTruncated = true;
    }
    this.dispatcher.publish(this.freeze(event as Partial<AgentToolEvent>));
  }

  private gap(turnId: string | null, errorCode: string, coverage: AgentToolCoverage, detail?: unknown): void {
    const state: BoundState = { truncated: false };
    const output = this.bounds.section(detail, AGENT_TOOL_TRACE_LIMITS.outputBytes, state);
    this.sequence += 1;
    this.dispatcher.publish(this.freeze({
      kind: 'observation-gap', source: 'provider-native', toolCallId: `gap:${randomUUID()}`, turnId, toolName: 'unknown', toolKind: 'unknown',
      errorCode, coverage, sequence: this.sequence, ...(output === undefined ? {} : { output }),
      ...(state.truncated ? { detailTruncated: true } : {}),
    }));
  }

  private freeze(event: Partial<AgentToolEvent>): AgentToolEvent {
    return deepFreeze({
      sessionId: this.init.sessionId, provider: this.init.provider, at: new Date().toISOString(), ...event,
    } as AgentToolEvent);
  }

  /** Instrumentation failure never reaches the Tool path; it becomes evidence when possible (never recursively). */
  private safely<T>(work: () => T): T | undefined {
    try { return work(); }
    catch {
      try { this.gap(null, 'TRACE_INSTRUMENTATION_FAILED', 'partial'); } catch { /* Nothing more can be done safely. */ }
      return undefined;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
