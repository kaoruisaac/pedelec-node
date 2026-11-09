import type { JsonValue, PedelecMonitorEvent, PedelecMonitorLayer, Unsubscribe } from './types.ts';

const MAX_DEPTH = 8;
const MAX_ENTRIES = 64;
const MAX_STRING_CHARS = 16 * 1024;

export type MonitorInput = Readonly<{
  kind: `${PedelecMonitorLayer}.${string}`;
  sessionId: string;
  turnId: string | null;
  data?: () => unknown;
}>;

export type MonitorObserver = (input: MonitorInput) => void;

/** Deep, bounded and frozen, so an observer can neither hold nor mutate the object the session keeps using. */
function immutableCopy(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === 'boolean') return value as JsonValue;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]` : value;
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return value === undefined ? null : '[omitted]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((entry) => immutableCopy(entry, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`[${value.length - MAX_ENTRIES} more]`);
    return Object.freeze(items);
  }
  const entries = Object.entries(value);
  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of entries.slice(0, MAX_ENTRIES)) {
    if (entry !== undefined) copy[key] = immutableCopy(entry, depth + 1);
  }
  if (entries.length > MAX_ENTRIES) copy['…'] = `[${entries.length - MAX_ENTRIES} more]`;
  return Object.freeze(copy);
}

/**
 * Read-only fan-out beside the session state machine. A listener that throws, rejects or stalls can only lose its own
 * events: nothing here returns a value to the session, and no session path waits on an observer.
 */
export class MonitorBus {
  private readonly listeners = new Set<(event: PedelecMonitorEvent) => unknown>();

  add(listener: (event: PedelecMonitorEvent) => unknown): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const entry = (event: PedelecMonitorEvent) => listener(event);
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  readonly observe: MonitorObserver = (input) => {
    if (this.listeners.size === 0) return;
    let event: PedelecMonitorEvent;
    try {
      event = Object.freeze({
        at: new Date().toISOString(),
        layer: input.kind.slice(0, input.kind.indexOf('.')) as PedelecMonitorLayer,
        kind: input.kind,
        sessionId: input.sessionId,
        turnId: input.turnId,
        data: immutableCopy(input.data?.() ?? null),
      });
    } catch { return; }
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event) as { catch?: (handler: () => void) => unknown } | undefined;
        result?.catch?.(() => undefined);
      } catch { /* An observer never reaches the agent path. */ }
    }
  };
}
