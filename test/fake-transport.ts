import { EventEmitter } from 'node:events';
import type { PedelecTransport, PedelecTransportConnection } from '../src/index.ts';

type Call = { method: string; input?: Record<string, unknown>; options?: unknown };

/** In-memory Rust IPC stand-in. Records every op and lets tests push worker events. */
export class FakeConnection extends EventEmitter {
  readonly calls: Call[] = [];
  sequence = 0;
  sessionId = '';
  failSend = false;
  failToolReply = false;
  badAck = false;
  /** Holds the toolReply ACK open so a test can fault the session while the reply is in flight. */
  toolReplyGate: Promise<void> | null = null;
  openData: Record<string, unknown> | null = null;
  shutdownCount = 0;
  /** undefined = the transport cannot tell; false = a Worker that survived its stop. */
  closed: boolean | undefined = undefined;
  /** Holds rehydrate open so a test can race dispose or eviction against it. */
  rehydrateGate: Promise<void> | null = null;
  failRehydrate = false;

  async openSession(input: Record<string, unknown>, options?: unknown) {
    this.calls.push({ method: 'openSession', input, options });
    this.sessionId = String(input.sessionId);
    return { data: this.openData ?? { provider: input.provider, runtimeStarted: true, providerSessionId: `thread-${this.sessionId}`, capabilities: { send: 'supported' } } };
  }
  async rehydrateSession(input: Record<string, unknown>) {
    this.calls.push({ method: 'rehydrateSession', input });
    this.sessionId = String(input.sessionId);
    if (this.rehydrateGate) await this.rehydrateGate;
    if (this.failRehydrate) throw Object.assign(new Error('rejected'), { code: 'PROVIDER_REHYDRATE_FAILED' });
    return { data: { provider: input.provider, providerSessionId: input.providerSessionId, rehydrated: true, runtimeStarted: true, capabilities: { send: 'supported' } } };
  }
  async send(input: Record<string, unknown>) {
    this.calls.push({ method: 'send', input });
    if (this.failSend) throw Object.assign(new Error('timeout'), { code: 'IPC_TIMEOUT' });
    return { data: { accepted: true, turnId: input.turnId } };
  }
  async cancel(input: Record<string, unknown>) { this.calls.push({ method: 'cancel', input }); return { data: { accepted: true } }; }
  async closeSession(input: Record<string, unknown>) { this.calls.push({ method: 'closeSession', input }); return { data: { accepted: true } }; }
  async toolReply(input: Record<string, unknown>) {
    this.calls.push({ method: 'toolReply', input });
    if (this.toolReplyGate) await this.toolReplyGate;
    if (this.failToolReply) throw Object.assign(new Error('timeout'), { code: 'IPC_TIMEOUT' });
    if (this.badAck) return { data: { acknowledged: false } };
    return { data: { acknowledged: true, turnId: input.turnId, toolCallId: input.toolCallId } };
  }
  async shutdown() { this.shutdownCount += 1; this.calls.push({ method: 'shutdown' }); }
  async terminate() { this.calls.push({ method: 'terminate' }); }

  push(kind: string, data: unknown, sequence = ++this.sequence) {
    this.emit('event', { sessionId: this.sessionId, sequence, kind, data });
  }
  count(method: string) { return this.calls.filter((call) => call.method === method).length; }
  last(method: string) { return this.calls.filter((call) => call.method === method).at(-1); }
}

export function fakeTransport(): PedelecTransport & { connections: FakeConnection[] } {
  const connections: FakeConnection[] = [];
  return {
    connections,
    async connect() {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection as unknown as PedelecTransportConnection;
    },
  };
}

export async function waitFor(assertion: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('TEST_WAIT_TIMEOUT');
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
