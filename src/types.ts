/** Public, transport-free types of the Pedelec Node SDK. Nothing here knows about IPC frames or Host storage. */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type PedelecProvider = 'codex' | 'claude' | 'opencode' | 'cursor' | 'ollama' | 'antigravity';
/** Actual Worker session receipt; Host-tool rollout evidence is checked separately. */
export type PedelecSessionCapabilities = Readonly<{
  runtimeOpen: boolean;
  sendTurn: boolean;
  hostTools: boolean;
  cancelTurn: 'native' | 'process-stop' | 'unsupported';
  resumeSession: boolean;
  monitorMetadata: boolean;
}>;
/** A Provider output file that has already landed. `path` is absolute and final; nothing needs moving. */
export type PedelecArtifactKind = 'image' | 'audio' | 'video' | 'file';
export type PedelecArtifact = Readonly<{
  id: string;
  name: string;
  /** Temporary absolute path. Copy into Host-managed storage before FIFO eviction or runtime restart. */
  path: string;
  kind: PedelecArtifactKind;
  source: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  providerArtifactId?: string;
  toolCallId?: string;
}>;

export type PedelecToolDescriptor = Readonly<{
  name: string;
  description: string;
  argsSchema: Readonly<Record<string, unknown>>;
}>;

/** Session status. `outcome-unknown` is terminal for effects: the SDK never retries or re-dispatches from it. */
export type PedelecSessionStatus = 'idle' | 'busy' | 'outcome-unknown' | 'unavailable' | 'ended';

/** Terminal state of one turn. `accepted` from sendText is never one of these. */
export type PedelecTurnTerminal = 'completed' | 'failed' | 'interrupted' | 'unknown';

export type PedelecToolCallState = 'running' | 'acknowledged' | 'unknown';

export type PedelecSessionContext = Readonly<{
  sessionId: string;
  provider: PedelecProvider;
  turnId: string | null;
  eventEmittedAt: string;
}>;

export type PedelecChatContext = PedelecSessionContext & Readonly<{ turnId: string; truncated: boolean }>;

/** The Turn that produced an artifact. Landing says nothing about how that Turn ended. */
export type PedelecArtifactContext = PedelecSessionContext & Readonly<{ turnId: string }>;

export type PedelecToolContext = Readonly<{
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  /** Aborted on cancel/close; long handlers should stop effects when it fires. */
  signal: AbortSignal;
  /** Throws when the callback no longer belongs to the active, uncancelled turn. Call it before each durable effect. */
  assertActive(): void;
}>;

/** One `tool-reply` payload. `result` must be JSON (including `null`) and at most 64 KiB once serialised. */
export type PedelecToolReply = Readonly<{ success: boolean; result: JsonValue }>;

export type PedelecToolHandler = (args: unknown, context: PedelecToolContext) => Promise<PedelecToolReply> | PedelecToolReply;

export type PedelecTurnOutcome = Readonly<{
  turnId: string;
  terminal: PedelecTurnTerminal;
  /** Raw provider terminal status, when one was received. */
  providerStatus: string | null;
  cancelRequested: boolean;
  toolCalls: readonly Readonly<{ toolCallId: string; toolName: string; state: PedelecToolCallState }>[];
}>;

export type PedelecErrorCategory =
  | 'TRANSPORT_FAILURE'
  | 'WORKER_CRASHED'
  | 'PROVIDER_ERROR'
  | 'EVENT_SEQUENCE_REVERSED'
  | 'TOOL_REQUEST_REJECTED'
  | 'TOOL_HANDLER_FAILED'
  | 'TOOL_RESULT_INVALID'
  | 'TOOL_ACK_UNKNOWN'
  | 'CHAT_HANDLER_FAILED'
  | 'ARTIFACT_STORAGE_FAILED'
  | 'ARTIFACT_HANDLER_FAILED';

/** Observable error. `message` is a fixed, sanitised sentence: never provider stderr, secrets or host paths. */
export type PedelecSessionError = Readonly<{ category: PedelecErrorCategory; message: string; turnId: string | null }>;

export type PedelecEndedReason = Readonly<{ reason: 'closed' | 'provider-closed' | 'worker-exited'; at: string }>;

export type Unsubscribe = () => void;

export type PedelecMonitorLayer = 'sdk' | 'session' | 'turn' | 'tool' | 'transport' | 'worker' | 'provider' | 'error';

/**
 * One read-only observation of a session. `session.*`, `turn.*`, `tool.*` and `error.*` report what the session state
 * machine already decided; `transport.*`, `worker.*` and `provider.*` observe runtime communication facts.
 * Default observations are metadata-only. With an explicit trusted `detailedMonitoring` SDK option, `sdk.*`
 * records callback dispatch and transport/provider events may include bounded payloads. The Host must
 * redact detailed payloads before RAM retention or exposure; never enable detailed mode on public Hosts.
 */
export type PedelecMonitorEvent = Readonly<{
  at: string;
  layer: PedelecMonitorLayer;
  kind: string;
  sessionId: string;
  turnId: string | null;
  data: JsonValue;
}>;

/* ----- Level 1 Agent Tool Trace (read-only observation; never controls execution) ----- */

/** `provider-native`: a Tool the Provider itself ran. `pedelec-host`: a Host Tool reached through `pedelec-cli` → `onTool`. */
export type AgentToolEventSource = 'provider-native' | 'pedelec-host';
export type AgentToolEventKind = 'started' | 'updated' | 'finished' | 'observation-gap';
export type AgentToolKind = 'shell' | 'file' | 'browser' | 'search' | 'mcp' | 'host' | 'other' | 'unknown';
/** Tool-level outcome only. A Turn's terminal state is never copied onto the Tools inside it. */
export type AgentToolStatus = 'running' | 'completed' | 'failed' | 'denied' | 'cancelled' | 'unknown';
/**
 * How completely this Provider/Session can be observed. `supported` means the adapter maps every Tool Invocation the
 * Provider exposes; it is a source-level declaration, not real-provider QA evidence.
 */
export type AgentToolCoverage = 'supported' | 'partial' | 'unsupported' | 'unknown';
/** A field the Provider did not report. Its absence on the event is a fact, never an empty value or a 0 exit code. */
export type AgentToolUnavailableField = 'turnId' | 'nativeToolCallId' | 'toolName' | 'input' | 'output' | 'stdout' | 'stderr' | 'exitCode';
/**
 * How `parentToolCallId` of a Host event was decided. Since 01A (event-first) Host events are always `unlinked`: the
 * `pedelec-cli` protocol carries no trusted parent id, and command-text matching across events was removed.
 * `command-match` / `ambiguous` are kept for type compatibility and are no longer produced. Timing is never used.
 */
export type AgentToolCorrelation = 'command-match' | 'ambiguous' | 'unlinked';

/**
 * A `pedelec-cli` call recognised inside the command of this same native Shell event (event-local hint only; it is not
 * a proven link to any Host event).
 */
export type AgentToolHostInvocation = Readonly<{ subcommand: 'tool-call' | 'tool-spec'; toolName: string }>;

/**
 * One immutable observation of an Agent Tool Invocation (01A event-first contract):
 * - Each Provider/Host fact is one event in arrival order. The SDK keeps no Tool Record state: it does not dedupe
 *   (a repeated Provider frame is delivered again, with its own `sequence`), does not infer missing phases
 *   (an only-`finished` call is delivered as is), and never synthesises a Tool `finished`/`unknown` at Turn end,
 *   cancel, close or crash. A Turn terminal is not evidence about its Tools; not seeing `finished` means "not observed".
 * - `input`/`output` keep the values the Provider/Handler reported (commands, args, stdout/stderr, paths, URLs,
 *   tokens): **not redacted**. They are size-bounded (`detailTruncated`). Consumers own ACL, display redaction,
 *   persistence and retention.
 * - Delivery is best-effort and bounded: real losses are announced by `observation-gap`, never silently skipped, but
 *   nothing is durable, replayed or exactly-once.
 */
export type AgentToolEvent = Readonly<{
  sessionId: string;
  turnId: string | null;
  provider: PedelecProvider;
  source: AgentToolEventSource;
  kind: AgentToolEventKind;
  /**
   * SDK id. Deterministic for (Session, Turn, source, native/Host id): the same Provider id in the same Turn always gets
   * the same value, a different Session or Turn never does. Without a known Turn or a native id, each event gets its own
   * random id (and `coverage: 'partial'`) — no later correlation is promised.
   */
  toolCallId: string;
  /** The Provider's own call id, only when the Provider reported one. */
  nativeToolCallId?: string;
  /** Native call that caused this one, only when the Provider frame names it explicitly (e.g. Claude sub-agent parent). */
  parentToolCallId?: string;
  /** Host events only: the `toolCallId` the `onTool` handler received in its context. */
  hostToolCallId?: string;
  /**
   * Provider's real tool name, or the Host Tool name. `unknown` only when the frame omitted it and the adapter's bounded
   * ID cache no longer had it (see `unavailable`).
   */
  toolName: string;
  toolKind: AgentToolKind;
  /** Observation time (Provider frame time when known). */
  at: string;
  /** Per-Session trace order, increasing by one per published event; a gap names the numbers it replaces. */
  sequence: number;
  status?: AgentToolStatus;
  /** Only an exit code the Provider explicitly reported. */
  exitCode?: number;
  input?: JsonValue;
  output?: JsonValue;
  errorCode?: string;
  coverage?: AgentToolCoverage;
  detailTruncated?: boolean;
  /** Reserved. Not produced since 01A: the SDK and Worker no longer redact Tool Trace values. */
  detailRedacted?: boolean;
  unavailable?: readonly AgentToolUnavailableField[];
  correlation?: AgentToolCorrelation;
  hostInvocations?: readonly AgentToolHostInvocation[];
  /** A Provider-native event naming a Turn of this Session that is no longer running (arrived after its terminal). */
  lateObservation?: boolean;
  /** `observation-gap` only: how many events this listener did not receive, and their sequence numbers. */
  droppedEvents?: number;
  droppedSequences?: Readonly<{ first: number; last: number }>;
}>;

export type AgentToolEventListener = (event: AgentToolEvent) => void | Promise<void>;
