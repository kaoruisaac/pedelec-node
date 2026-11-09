import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPedelecRuntime, defineTool, PedelecError, type PedelecArtifact, type PedelecMonitorEvent, type PedelecSessionError, type PedelecTurnOutcome } from '../src/index.ts';
import { fakeTransport, settle, waitFor, type FakeConnection } from './fake-transport.ts';

const updateScript = defineTool({ name: 'updateScript', description: 'Sync graph.', argsSchema: { type: 'object', properties: {}, required: [] } });
const base = { runtimeStorageRoot: '', provider: 'codex', model: 'gpt-test', effort: 'high', workdir: '/srv/task-1', tools: [updateScript] };

const clients: Awaited<ReturnType<typeof createPedelecRuntime>>[] = [];
let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-contract-')));
  base.runtimeStorageRoot = join(directory, 'runtime');
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  rmSync(directory, { recursive: true, force: true });
});
async function runtime(...args: Parameters<typeof createPedelecRuntime>) {
  const client = await createPedelecRuntime(...args);
  clients.push(client);
  return client;
}

async function setup() {
  const transport = fakeTransport();
  const sdk = await runtime({ transport });
  const session = await sdk.createSession({ ...base, runtimeStorageRoot: join(directory, randomUUID()) });
  const connection = transport.connections[0]!;
  return { transport, sdk, session, connection };
}

describe('SDK-01 API parity and identity', () => {
  it('opens with provider/workdir but no Host identity in SDK or IPC', async () => {
    const { sdk, session, connection } = await setup();
    expect(connection.last('openSession')!.input).toMatchObject({
      sessionId: session.sessionId, provider: 'codex', model: 'gpt-test', effort: 'high',
      serverWorkdir: '/srv/task-1', tools: [{ name: 'updateScript' }],
    });
    expect(session.providerSessionId).toBe(`thread-${session.sessionId}`);
    expect(session.providerSessionId).not.toBe(session.sessionId);
    expect(session.provider).toBe('codex');
    expect('scope' in session).toBe(false);
    expect('role' in session).toBe(false);
    expect(session.getStatus()).toBe('idle');
    expect(connection.last('openSession')!.input).not.toHaveProperty('scope');
    expect(connection.last('openSession')!.input).not.toHaveProperty('role');
    await sdk.close();
    expect(session.getStatus()).toBe('ended');
    expect(connection.shutdownCount).toBe(1);
  });

  it('rejects relative workdirs and any Host identity or metadata fields', async () => {
    const sdk = await runtime({ transport: fakeTransport() });
    await expect(sdk.createSession({ ...base, workdir: 'relative/path' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sdk.createSession({ ...base, role: 'planner' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sdk.createSession({ ...base, scope: { workspaceId: 'w', taskId: 't' } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sdk.createSession({ ...base, metadata: { purpose: 'planner' } } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses the first send until every declared tool has a handler; unsubscribe stops dispatch', async () => {
    const { session, connection } = await setup();
    await expect(session.sendText('hello')).rejects.toMatchObject({ code: 'HANDLER_MISSING' });
    expect(connection.count('send')).toBe(0);
    const chats: string[] = [];
    const off = session.onChat((content) => { chats.push(content); });
    session.onTool('updateScript', () => ({ success: true, result: null }));
    expect(() => session.onTool('updateScript', () => ({ success: true, result: null }))).toThrow(PedelecError);
    expect(() => session.onTool('notDeclared', () => ({ success: true, result: null }))).toThrow(PedelecError);
    off();
    const receipt = await session.sendText('hello', { turnId: 'turn-1' });
    expect(receipt).toEqual({ accepted: true, sessionId: session.sessionId, turnId: 'turn-1' });
    expect(session.getStatus()).toBe('busy');
    connection.push('turn', { type: 'assistant-message', text: 'done' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    expect(chats).toEqual([]);
  });
});

describe('SDK-02 event semantics', () => {
  it('emits deltas live and exactly one complete chat message after the terminal event', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const deltas: string[] = [], chats: Array<[string, string]> = [], outcomes: PedelecTurnOutcome[] = [];
    session.onChatDelta((text) => { deltas.push(text); });
    session.onChat((content, context) => { chats.push([content, context.turnId]); });
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('go', { turnId: 'turn-a' });
    connection.push('turn', { type: 'started', providerTurnId: 'p-1' });
    connection.push('turn', { type: 'assistant-delta', text: 'Hel' });
    connection.push('turn', { type: 'assistant-delta', text: 'lo' });
    await waitFor(() => deltas.length === 2);
    expect(chats).toHaveLength(0);
    connection.push('turn', { type: 'assistant-message', text: 'Hello' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => outcomes.length === 1);
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(chats).toEqual([['Hello', 'turn-a']]);
    expect(outcomes[0]).toMatchObject({ turnId: 'turn-a', terminal: 'completed', providerStatus: 'completed' });
    expect(session.getStatus()).toBe('idle');
  });

  it('keeps sessions isolated and ignores events for another session id', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const one = await sdk.createSession(base);
    const two = await sdk.createSession(base);
    expect(one.sessionId).not.toBe(two.sessionId);
    const [c1, c2] = transport.connections;
    const chats: string[] = [];
    for (const session of [one, two]) {
      session.onTool('updateScript', () => ({ success: true, result: null }));
      session.onChat((content, context) => { chats.push(`${context.sessionId === one.sessionId ? 'one' : 'two'}:${content}`); });
      await session.sendText('go');
    }
    c1!.emit('event', { sessionId: two.sessionId, sequence: 1, kind: 'terminal', data: { status: 'completed' } });
    c2!.push('turn', { type: 'assistant-message', text: 'B' });
    c2!.push('terminal', { status: 'completed' });
    await waitFor(() => chats.length === 1);
    expect(chats).toEqual(['two:B']);
    expect(one.getStatus()).toBe('busy');
    await sdk.close();
  });

  it('fails closed on a reversed sequence', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const errors: PedelecSessionError[] = [];
    session.onError((error) => { errors.push(error); });
    await session.sendText('go');
    connection.push('turn', { type: 'assistant-delta', text: 'x' }, 5);
    connection.push('terminal', { status: 'completed' }, 4);
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.category).toBe('EVENT_SEQUENCE_REVERSED');
    expect(session.getStatus()).toBe('outcome-unknown');
  });
});

describe('SDK-03 tool roundtrip', () => {
  it('awaits the handler before one tool-reply with the raw JSON result (including null)', async () => {
    const { session, connection } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: unknown[] = [];
    session.onTool('updateScript', async (args, context) => {
      seen.push({ args, turnId: context.turnId, toolCallId: context.toolCallId, keys: Object.keys(context).sort() });
      context.assertActive();
      await gate;
      return { success: true, result: null };
    });
    await session.sendText('go', { turnId: 'turn-t' });
    connection.push('tool-request', { turnId: 'turn-t', toolCallId: 'call-1', toolName: 'updateScript', args: {} });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ args: {}, turnId: 'turn-t', toolCallId: 'call-1' });
    expect(seen[0]).not.toHaveProperty('scope');
    await settle();
    expect(connection.count('toolReply')).toBe(0);
    release();
    await waitFor(() => connection.count('toolReply') === 1);
    expect(connection.last('toolReply')!.input).toMatchObject({ turnId: 'turn-t', toolCallId: 'call-1', success: true, result: null });
  });

  it('refuses undeclared tools, wrong turns and oversized results without a reply', async () => {
    const { session, connection } = await setup();
    const errors: string[] = [];
    session.onError((error) => { errors.push(error.category); });
    session.onTool('updateScript', () => ({ success: true, result: 'x'.repeat(70_000) }));
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('tool-request', { turnId: 'turn-1', toolCallId: 'c1', toolName: 'returnToolResult', args: {} });
    await waitFor(() => errors.length === 1);
    expect(errors).toEqual(['TOOL_REQUEST_REJECTED']);
    expect(session.getStatus()).toBe('outcome-unknown');
    expect(connection.count('toolReply')).toBe(0);

    const second = await setup();
    const categories: string[] = [];
    second.session.onError((error) => { categories.push(error.category); });
    second.session.onTool('updateScript', () => ({ success: true, result: 'x'.repeat(70_000) }));
    await second.session.sendText('go', { turnId: 'turn-2' });
    second.connection.push('tool-request', { turnId: 'other-turn', toolCallId: 'c1', toolName: 'updateScript', args: {} });
    await waitFor(() => categories.length === 1);
    expect(categories).toEqual(['TOOL_REQUEST_REJECTED']);

    const third = await setup();
    const third_errors: string[] = [];
    third.session.onError((error) => { third_errors.push(error.category); });
    third.session.onTool('updateScript', () => ({ success: true, result: 'x'.repeat(70_000) }));
    await third.session.sendText('go', { turnId: 'turn-3' });
    third.connection.push('tool-request', { turnId: 'turn-3', toolCallId: 'c1', toolName: 'updateScript', args: {} });
    await waitFor(() => third_errors.length === 1);
    expect(third_errors).toEqual(['TOOL_RESULT_INVALID']);
    expect(third.connection.count('toolReply')).toBe(0);
  });
});

describe('SDK-04 no replay', () => {
  it('marks send timeout outcome-unknown and never resends', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    connection.failSend = true;
    await expect(session.sendText('go', { turnId: 't' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', transportCode: 'IPC_TIMEOUT' });
    expect(session.getStatus()).toBe('outcome-unknown');
    await expect(session.sendText('again', { turnId: 't2' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(connection.count('send')).toBe(1);
  });

  it('does not dispatch a duplicate toolCallId and does not retry an unknown ACK', async () => {
    const { session, connection } = await setup();
    let calls = 0;
    session.onTool('updateScript', () => { calls += 1; return { success: true, result: { ok: true } }; });
    connection.failToolReply = true;
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('go', { turnId: 't' });
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await settle();
    expect(calls).toBe(1);
    expect(connection.count('toolReply')).toBe(1);
    expect(session.getStatus()).toBe('outcome-unknown');
    // A fail-closed session stops its worker and ends the turn itself, exactly once.
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => outcomes.length === 1);
    await settle();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ terminal: 'unknown', toolCalls: [{ toolCallId: 'c', state: 'unknown' }] });
  });

  it('does not ACK a handler that finishes after cancel, nor one that throws', async () => {
    const { session, connection } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalAborted = false;
    session.onTool('updateScript', async (_args, context) => {
      await gate;
      signalAborted = context.signal.aborted;
      return { success: true, result: null };
    });
    await session.sendText('go', { turnId: 't' });
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await settle();
    await session.cancel('user cancelled');
    release();
    await settle();
    expect(signalAborted).toBe(true);
    expect(connection.count('cancel')).toBe(1);
    expect(connection.count('toolReply')).toBe(0);

    const thrower = await setup();
    const errors: string[] = [];
    thrower.session.onError((error) => { errors.push(error.category); });
    thrower.session.onTool('updateScript', async () => { throw new Error('secret /private/path token=abc'); });
    await thrower.session.sendText('go', { turnId: 't' });
    thrower.connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await waitFor(() => errors.length === 1);
    expect(errors).toEqual(['TOOL_HANDLER_FAILED']);
    expect(thrower.connection.count('toolReply')).toBe(0);
    expect(thrower.session.getStatus()).toBe('outcome-unknown');
  });

  it('treats a non-confirming ACK as unknown and a worker crash as outcome-unknown with no replay', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    connection.badAck = true;
    const errors: PedelecSessionError[] = [];
    session.onError((error) => { errors.push(error); });
    await session.sendText('go', { turnId: 't' });
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.category).toBe('TOOL_ACK_UNKNOWN');
    // The unknown ACK already stopped the worker, so its exit is not a second fault.
    connection.emit('crash', { code: null, signal: 'SIGKILL' });
    await settle();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toMatch(/SIGKILL|private|token/);
    expect(connection.count('send')).toBe(1);
    expect(connection.count('toolReply')).toBe(1);
  });

  it('a failing chat handler leaves the turn unknown and never becomes an unhandled rejection', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    session.onChat(async () => { throw new Error('DB write failed'); });
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('go', { turnId: 't' });
    connection.push('turn', { type: 'assistant-message', text: 'Hi' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => outcomes.length === 1);
    expect(outcomes[0]!.terminal).toBe('unknown');
    expect(session.getStatus()).toBe('outcome-unknown');
  });
});

/** A session with every observable recorded, mid-turn or idle, for the fail-closed cases below. */
async function armed(options: Readonly<{ start?: boolean }> = {}) {
  const context = await setup();
  const { session } = context;
  const seen = {
    handlerCalls: 0, chats: [] as string[], outcomes: [] as PedelecTurnOutcome[], errors: [] as string[], statuses: [] as string[],
  };
  session.onChat((content) => { seen.chats.push(content); });
  session.onTurnEnded((outcome) => { seen.outcomes.push(outcome); });
  session.onError((error) => { seen.errors.push(error.category); });
  session.onStatus((status) => { seen.statuses.push(status); });
  if (options.start !== false) {
    session.onTool('updateScript', () => { seen.handlerCalls += 1; return { success: true, result: null }; });
    await session.sendText('go', { turnId: 'turn' });
  }
  return { ...context, seen };
}

type Armed = Awaited<ReturnType<typeof armed>>;
const lateTool = (id = 'late', turnId = 'turn') => ({ turnId, toolCallId: id, toolName: 'updateScript', args: {} });

/** Every way a session can lose trust in its transport; each waits until the fault was actually reported. */
const FAULTS: ReadonlyArray<readonly [string, string, (context: Armed) => Promise<void>]> = [
  ['worker crash', 'WORKER_CRASHED', async ({ connection }) => { connection.emit('crash', {}); }],
  ['transport failure', 'TRANSPORT_FAILURE', async ({ connection }) => { connection.emit('failure', new Error('rpc lost')); }],
  ['sequence reversal', 'EVENT_SEQUENCE_REVERSED', async ({ connection }) => {
    connection.push('turn', { type: 'assistant-delta', text: 'x' }, 5);
    connection.push('turn', { type: 'assistant-delta', text: 'y' }, 4);
    connection.sequence = 5;
  }],
  ['provider failure', 'PROVIDER_ERROR', async ({ connection }) => { connection.push('provider-error', { code: 'PROVIDER_PROTOCOL_ERROR' }); }],
];

describe('P0-01 no tool effect after a fault', () => {
  it.each(FAULTS)('%s → late tool-request runs no handler and sends no reply', async (_name, category, fault) => {
    const context = await armed();
    await fault(context);
    await waitFor(() => context.seen.errors.length === 1);
    context.connection.push('tool-request', lateTool());
    await settle();
    expect(context.seen.handlerCalls).toBe(0);
    expect(context.connection.count('toolReply')).toBe(0);
    expect(context.seen.errors).toEqual([category]);
    expect(context.session.getStatus()).toBe('outcome-unknown');
  });

  it('drops a tool-request already queued behind the fault', async () => {
    const { connection, session, seen } = await armed();
    connection.push('tool-request', lateTool());
    connection.emit('crash', {});
    await settle();
    expect(seen.handlerCalls).toBe(0);
    expect(connection.count('toolReply')).toBe(0);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('refuses tools after an unconfirmed send, which also loses the transport', async () => {
    const { session, connection } = await setup();
    let calls = 0;
    session.onTool('updateScript', () => { calls += 1; return { success: true, result: null }; });
    connection.failSend = true;
    await expect(session.sendText('go', { turnId: 'turn' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    connection.push('tool-request', lateTool());
    await settle();
    expect(calls).toBe(0);
    expect(connection.count('toolReply')).toBe(0);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it.each(['crash', 'failure'])('%s during a handler → late completion sends no reply and adds no failure', async (signal) => {
    const { session, connection, seen } = await armed({ start: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false, assertion: unknown = null;
    session.onTool('updateScript', async (_args, tool) => {
      seen.handlerCalls += 1;
      await gate;
      aborted = tool.signal.aborted;
      try { tool.assertActive(); } catch (error) { assertion = error; }
      return { success: true, result: null };
    });
    await session.sendText('go', { turnId: 'turn' });
    connection.push('tool-request', lateTool('call'));
    await waitFor(() => seen.handlerCalls === 1);
    connection.emit(signal, new Error('lost'));
    await waitFor(() => seen.errors.length === 1);
    release();
    await settle();
    expect(aborted).toBe(true);
    expect(assertion).toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(seen.handlerCalls).toBe(1);
    expect(connection.count('toolReply')).toBe(0);
    expect(seen.errors).toHaveLength(1);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('a fault during the in-flight reply keeps the call unknown even when the ACK then succeeds', async () => {
    const { connection, session, seen } = await armed();
    let release!: () => void;
    connection.toolReplyGate = new Promise<void>((resolve) => { release = resolve; });
    connection.push('tool-request', lateTool('call'));
    await waitFor(() => connection.count('toolReply') === 1);
    connection.emit('crash', {});
    await waitFor(() => seen.errors.length === 1);
    release();
    await settle();
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    expect(seen.errors).toEqual(['WORKER_CRASHED']);
    expect(seen.outcomes[0]).toMatchObject({ terminal: 'unknown', toolCalls: [{ toolCallId: 'call', state: 'unknown' }] });
    expect(connection.count('toolReply')).toBe(1);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('an idle fault stays unavailable and cannot be used again', async () => {
    const { session, connection } = await setup();
    let calls = 0;
    session.onTool('updateScript', () => { calls += 1; return { success: true, result: null }; });
    connection.emit('crash', {});
    await waitFor(() => session.getStatus() === 'unavailable');
    connection.push('tool-request', lateTool());
    connection.push('terminal', { status: 'completed' });
    await settle();
    expect(calls).toBe(0);
    expect(session.getStatus()).toBe('unavailable');
    await expect(session.sendText('later')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(connection.count('send')).toBe(0);
  });

  it('terminates the worker once and leaves close idempotent', async () => {
    const { connection, session, seen } = await armed();
    connection.push('provider-error', { code: 'PROVIDER_PROTOCOL_ERROR' });
    await waitFor(() => seen.errors.length === 1);
    connection.emit('crash', {});
    await settle();
    expect(connection.count('terminate')).toBe(1);
    await session.close('cleanup after fault');
    expect(session.getStatus()).toBe('ended');
  });

  it('keeps the normal tool flow: one handler, one reply, acknowledged', async () => {
    const { connection, session, seen } = await armed();
    connection.push('tool-request', lateTool('call'));
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('turn', { type: 'assistant-message', text: 'done' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    expect(seen.handlerCalls).toBe(1);
    expect(connection.count('toolReply')).toBe(1);
    expect(seen.outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [{ toolCallId: 'call', state: 'acknowledged' }] });
    expect(seen.chats).toEqual(['done']);
    expect(session.getStatus()).toBe('idle');
    expect(connection.count('terminate')).toBe(0);
  });
});

describe('P0-02 outcome-unknown is irreversible', () => {
  it.each(FAULTS)('%s → late message and completed never reach onChat, completed or idle', async (_name, category, fault) => {
    const context = await armed();
    const { connection, session, seen } = context;
    await fault(context);
    await waitFor(() => seen.errors.length === 1);
    connection.push('turn', { type: 'assistant-message', text: 'completed after fault' });
    connection.push('terminal', { status: 'completed' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    await settle();
    expect(seen.chats).toEqual([]);
    expect(seen.outcomes).toHaveLength(1);
    expect(seen.outcomes[0]).toMatchObject({ turnId: 'turn', terminal: 'unknown' });
    expect(seen.errors).toEqual([category]);
    expect(seen.statuses).not.toContain('idle');
    expect(session.getStatus()).toBe('outcome-unknown');
    expect(connection.count('toolReply')).toBe(0);
    await expect(session.sendText('again', { turnId: 'turn-2' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  });

  it('a late provider failed/interrupted after a fault is still unknown', async () => {
    for (const status of ['failed', 'interrupted']) {
      const { connection, session, seen } = await armed();
      connection.emit('crash', {});
      await waitFor(() => seen.errors.length === 1);
      connection.push('terminal', { status });
      await waitFor(() => seen.outcomes.length === 1);
      expect(seen.outcomes[0]!.terminal).toBe('unknown');
      expect(session.getStatus()).toBe('outcome-unknown');
    }
  });

  it('later faults add no further failure notification', async () => {
    const { connection, seen } = await armed();
    connection.emit('crash', {});
    await waitFor(() => seen.errors.length === 1);
    connection.emit('failure', new Error('again'));
    connection.push('provider-error', { code: 'PROVIDER_PROTOCOL_ERROR' });
    connection.push('turn', { type: 'assistant-delta', text: 'x' }, 1);
    await settle();
    expect(seen.errors).toEqual(['WORKER_CRASHED']);
  });

  it('a late provider close does not end a faulted session behind the Server', async () => {
    const { connection, session, seen } = await armed();
    connection.emit('crash', {});
    await waitFor(() => seen.errors.length === 1);
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    connection.push('terminal', { status: 'closed' });
    await settle();
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('a crash after a turn already ended unknown does not downgrade it to unavailable', async () => {
    const { connection, session, seen } = await armed();
    await session.cancel('stop');
    connection.push('terminal', { status: 'interrupted' });
    await waitFor(() => seen.outcomes.length === 1);
    connection.emit('crash', {});
    await waitFor(() => seen.errors.length === 1);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('a crash while the chat handler persists a completed turn does not return to idle', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const outcomes: PedelecTurnOutcome[] = [];
    session.onChat(async () => { entered = true; await gate; });
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('go', { turnId: 'turn' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => entered);
    connection.emit('crash', {});
    release();
    await waitFor(() => outcomes.length === 1);
    expect(outcomes[0]!.terminal).toBe('completed');
    expect(session.getStatus()).toBe('unavailable');
  });

  it('keeps the normal failed and interrupted terminals', async () => {
    for (const status of ['failed', 'interrupted'] as const) {
      const { connection, session, seen } = await armed();
      connection.push('terminal', { status });
      await waitFor(() => seen.outcomes.length === 1);
      expect(seen.outcomes[0]).toMatchObject({ terminal: status, providerStatus: status });
      expect(seen.chats).toEqual([]);
      expect(session.getStatus()).toBe('outcome-unknown');
    }
  });
});

describe('SDK-06 lifecycle', () => {
  it('close is idempotent, stops the worker, emits onEnded and dispatches nothing afterwards', async () => {
    const { sdk, session, connection } = await setup();
    const chats: string[] = [];
    let ended = 0;
    session.onTool('updateScript', () => ({ success: true, result: null }));
    session.onChat((content) => { chats.push(content); });
    session.onEnded(() => { ended += 1; });
    await session.sendText('go');
    await session.close('conversation closed');
    await session.close('again');
    expect(ended).toBe(1);
    expect(connection.count('closeSession')).toBe(1);
    expect(connection.shutdownCount).toBe(1);
    connection.push('terminal', { status: 'completed' });
    await settle();
    expect(chats).toEqual([]);
    await expect(session.sendText('later')).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    // Closed mid-Turn: the outcome is unknown, so nothing recoverable stays behind.
    expect(sdk.sessionCount).toBe(0);
    expect(connection.listenerCount('event')).toBe(0);
  });

  it('refuses a duplicate turn id and concurrent sends', async () => {
    const { session, connection } = await setup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    await session.sendText('go', { turnId: 't1' });
    await expect(session.sendText('second', { turnId: 't2' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    await expect(session.sendText('dup', { turnId: 't1' })).rejects.toMatchObject({ code: 'DUPLICATE_TURN' });
    expect(connection.count('send')).toBe(1);
  });

  it('resumeSession is ID-only and returns only a handle this Runtime holds', async () => {
    const first = fakeTransport();
    const sdk = await runtime({ transport: first });
    const session = await sdk.createSession({ ...base, sessionId: 'conv-1' });
    expect(await sdk.resumeSession('conv-1')).toBe(session);
    await expect(sdk.resumeSession('missing-id')).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    await expect(sdk.resumeSession('conv-1', {} as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await session.close('done');
    expect(await sdk.resumeSession('conv-1')).toBe(session);
    expect(first.connections).toHaveLength(1);
    await sdk.close();
  });

  it('a new Runtime knows nothing of an earlier one: no record, no Worker, no new Provider thread', async () => {
    const earlier = await runtime({ transport: fakeTransport() });
    await (await earlier.createSession({ ...base, sessionId: 'old-life' })).close('done');
    expect(await earlier.peekSessionStatus('old-life')).toBe('ended');
    const transport = fakeTransport();
    const later = await runtime({ transport });
    await expect(later.resumeSession('old-life')).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(await later.peekSessionStatus('old-life')).toBeNull();
    expect(() => later.replaceEndedSession('old-life')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    expect(transport.connections).toHaveLength(0);
    await later.close();
    await earlier.close();
  });

  it('peekSessionStatus reads the RAM handle without a Worker', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'peek-live' });
    expect(await sdk.peekSessionStatus('peek-live')).toBe('idle');
    await session.close('done');
    expect(await sdk.peekSessionStatus('peek-live')).toBe('ended');
    expect(await sdk.peekSessionStatus('peek-missing')).toBeNull();
    await expect(sdk.peekSessionStatus('bad\nid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(transport.connections).toHaveLength(1);
    await sdk.close();
  });

  it('an unconfirmed Turn is not recoverable: closed outcome-unknown leaves the Runtime', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'failed-turn' });
    session.onTool('updateScript', () => ({ success: true, result: null }));
    await session.sendText('work', { turnId: 't' });
    transport.connections[0]!.push('terminal', { turnId: 't', status: 'failed' });
    await waitFor(() => session.getStatus() === 'outcome-unknown');
    await session.close('finished');
    expect(await sdk.peekSessionStatus('failed-turn')).toBeNull();
    await expect(session.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(transport.connections).toHaveLength(1);
    await sdk.close();
  });

  it('keeps a faulted handle visible until the Host closes it, reporting the Worker as stopped', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'crashed' });
    transport.connections[0]!.emit('crash', {});
    await waitFor(() => session.getStatus() === 'unavailable');
    await settle();
    expect(await sdk.peekSessionStatus('crashed')).toBe('unavailable');
    expect(session.isWorkerStopped()).toBe(true);
    await session.close('cleanup');
    expect(await sdk.peekSessionStatus('crashed')).toBeNull();
    await sdk.close();
  });

  it('reports a Worker that survived its stop as not stopped', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'stuck' });
    expect(session.isWorkerStopped()).toBe(false);
    transport.connections[0]!.closed = false;
    await session.close('done');
    expect(session.isWorkerStopped()).toBe(false);
    await sdk.close();
  });

  it('keeps a clean close resumable in RAM, without a Worker or a listener behind it', async () => {
    const { sdk, session, connection } = await setup();
    await session.close('done');
    expect(sdk.getSession(session.sessionId)).toBe(session);
    expect(session.getStatus()).toBe('ended');
    expect(session.isWorkerStopped()).toBe(true);
    expect(connection.listenerCount('event')).toBe(0);
    await sdk.close();
    expect(sdk.sessionCount).toBe(0);
  });

  it('reactivates the same ended handle without requiring persistent storage', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'in-memory-end' });
    const thread = session.providerSessionId;
    await session.close('done');
    expect(session.getStatus()).toBe('ended');
    await session.resume();
    expect(session.getStatus()).toBe('idle');
    expect(transport.connections[1]!.last('rehydrateSession')!.input?.providerSessionId).toBe(thread);
    expect(transport.connections[1]!.count('openSession')).toBe(0);
    session.onTool('updateScript', () => ({ success: true, result: null }));
    await session.sendText('new turn', { turnId: 'second-turn' });
    transport.connections[1]!.push('terminal', { status: 'completed' }, 1);
    await waitFor(() => session.getStatus() === 'idle');
    await sdk.close();
  });

  it('cleans up the worker when the provider does not confirm the open', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport: { connect: async () => {
      const connection = await transport.connect();
      (connection as unknown as { openData: unknown }).openData = { provider: 'codex' };
      return connection;
    } } });
    await expect(sdk.createSession(base)).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(transport.connections[0]!.shutdownCount).toBe(1);
    expect(sdk.sessionCount).toBe(0);
  });
});

describe('SDK ended retention / no active Session ceiling', () => {
  it('releases the oldest provider-ended live handle without persistent storage or resurrecting a stale reference', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    let oldest!: Awaited<ReturnType<typeof sdk.createSession>>;
    try {
      for (let i = 0; i < 51; i++) {
        const id = `provider-ended-${i}`;
        const session = await sdk.createSession({ ...base, sessionId: id });
        if (i === 0) oldest = session;
        transport.connections[i]!.push('terminal', { status: 'closed' });
        await waitFor(() => session.getStatus() === 'ended');
        await settle();
      }
      await waitFor(() => sdk.getSession('provider-ended-0') === undefined);
      expect(sdk.sessionCount).toBe(50);
      expect(sdk.getSession('provider-ended-1')?.getStatus()).toBe('ended');
      await expect(oldest.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    } finally { await sdk.close(); }
  });

  it('does not reject a 65th or 70th active Session', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    try {
      const sessions = await Promise.all(Array.from({ length: 70 }, (_, i) =>
        sdk.createSession({ ...base, sessionId: `active-${i}` })));
      expect(sdk.sessionCount).toBe(70);
      expect(sessions.every((session) => session.getStatus() === 'idle')).toBe(true);
      expect(transport.connections).toHaveLength(70);
    } finally { await sdk.close(); }
    expect(sdk.sessionCount).toBe(0);
  });

  it('keeps the newest 50 by END order, not create order, and refuses the evicted reference', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    try {
      const firstCreated = await sdk.createSession({ ...base, sessionId: 'created-first' });
      const secondCreated = await sdk.createSession({ ...base, sessionId: 'created-second' });
      await secondCreated.close('ended first');
      await firstCreated.close('ended second');
      for (let i = 0; i < 49; i++) await (await sdk.createSession({ ...base, sessionId: `ended-${String(i).padStart(2, '0')}` })).close('done');
      const active = await sdk.createSession({ ...base, sessionId: 'still-idle' });
      expect(await sdk.peekSessionStatus('created-second')).toBeNull();
      expect(await sdk.peekSessionStatus('created-first')).toBe('ended');
      expect(await sdk.peekSessionStatus('ended-48')).toBe('ended');
      expect(await sdk.peekSessionStatus(active.sessionId)).toBe('idle');
      await expect(secondCreated.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      await sdk.createSession({ ...base, sessionId: 'more' }).then((session) => session.close('done'));
      expect(await sdk.peekSessionStatus('created-first')).toBeNull();
      expect(await sdk.peekSessionStatus(active.sessionId)).toBe('idle');
    } finally { await sdk.close(); }
  });

  it('a resumed then re-ended handle moves to the newest position', async () => {
    const sdk = await runtime({ transport: fakeTransport() });
    try {
      const reused = await sdk.createSession({ ...base, sessionId: 'reused' });
      await reused.close('first end');
      for (let i = 0; i < 49; i++) await (await sdk.createSession({ ...base, sessionId: `filler-${i}` })).close('done');
      await reused.resume();
      await reused.close('second end');
      await (await sdk.createSession({ ...base, sessionId: 'over-limit' })).close('done');
      expect(await sdk.peekSessionStatus('reused')).toBe('ended');
      expect(await sdk.peekSessionStatus('filler-0')).toBeNull();
    } finally { await sdk.close(); }
  });

  it('never counts idle, busy, outcome-unknown or unavailable handles against ended retention', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    try {
      const idle = await sdk.createSession({ ...base, sessionId: 'keep-idle' });
      const busy = await sdk.createSession({ ...base, sessionId: 'keep-busy' });
      busy.onTool('updateScript', () => ({ success: true, result: null }));
      await busy.sendText('work', { turnId: 'busy-turn' });
      const unknown = await sdk.createSession({ ...base, sessionId: 'keep-unknown' });
      unknown.onTool('updateScript', () => ({ success: true, result: null }));
      await unknown.sendText('work', { turnId: 'unknown-turn' });
      transport.connections[2]!.push('terminal', { turnId: 'unknown-turn', status: 'failed' });
      await waitFor(() => unknown.getStatus() === 'outcome-unknown');
      const crashed = await sdk.createSession({ ...base, sessionId: 'keep-crashed' });
      transport.connections[3]!.emit('crash', {});
      await waitFor(() => crashed.getStatus() === 'unavailable');
      for (let i = 0; i < 60; i++) await (await sdk.createSession({ ...base, sessionId: `churn-${i}` })).close('done');
      expect(idle.getStatus()).toBe('idle');
      expect(busy.getStatus()).toBe('busy');
      expect(unknown.getStatus()).toBe('outcome-unknown');
      expect(await sdk.peekSessionStatus('keep-crashed')).toBe('unavailable');
      expect(sdk.sessionCount).toBe(54);
    } finally { await sdk.close(); }
  });

  it('never evicts a handle a resume owns; the next oldest goes instead', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport: { connect: async () => {
      const connection = await transport.connect();
      if (transport.connections.length === 52) (connection as unknown as FakeConnection).rehydrateGate = gate;
      return connection;
    } } });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    try {
      const oldest = await sdk.createSession({ ...base, sessionId: 'oldest' });
      const duringResume = join(oldest.artifactDirectory, 'landed');
      writeFileSync(duringResume, 'keep');
      await oldest.close('done');
      const fillers = [];
      for (let i = 0; i < 49; i++) { const session = await sdk.createSession({ ...base, sessionId: `keep-${i}` }); await session.close('done'); fillers.push(session); }
      const extra = await sdk.createSession({ ...base, sessionId: 'pending-end' });
      const resuming = oldest.resume();
      await waitFor(() => transport.connections.length === 52);
      await extra.close('done');
      expect(oldest.isResuming()).toBe(true);
      expect(await sdk.peekSessionStatus('keep-0')).toBeNull();
      expect(sdk.getSession('oldest')).toBe(oldest);
      expect(readFileSync(duringResume, 'utf8')).toBe('keep');
      expect(existsSync(fillers[0]!.artifactDirectory)).toBe(false);
      open();
      await resuming;
      expect(oldest.getStatus()).toBe('idle');
    } finally { open(); await sdk.close(); }
  });

  it('a disposed handle cannot be revived, and a dispose during resume leaves no Worker behind', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport: { connect: async () => {
      const connection = await transport.connect();
      if (transport.connections.length === 3) (connection as unknown as FakeConnection).rehydrateGate = gate;
      return connection;
    } } });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const closed = await sdk.createSession({ ...base, sessionId: 'closed-then-disposed' });
    await closed.close('done');
    await closed.dispose();
    await expect(closed.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(await sdk.peekSessionStatus('closed-then-disposed')).toBeNull();

    const raced = await sdk.createSession({ ...base, sessionId: 'raced' });
    await raced.close('done');
    const resuming = raced.resume();
    await waitFor(() => transport.connections.length === 3);
    await raced.dispose();
    open();
    await expect(resuming).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(transport.connections[2]!.shutdownCount).toBe(1);
    expect(await sdk.peekSessionStatus('raced')).toBeNull();
    await sdk.close();
  });

  it('a failed rehydrate is never retried and is not eligible again', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport: { connect: async () => {
      const connection = await transport.connect();
      if (transport.connections.length === 2) (connection as unknown as FakeConnection).failRehydrate = true;
      return connection;
    } } });
    const session = await sdk.createSession({ ...base, sessionId: 'lost-thread' });
    await session.close('done');
    await expect(session.resume()).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(transport.connections[1]!.shutdownCount).toBe(1);
    expect(transport.connections[1]!.count('openSession')).toBe(0);
    expect(await sdk.peekSessionStatus('lost-thread')).toBe('unavailable');
    await session.resume();
    expect(session.getStatus()).toBe('unavailable');
    expect(() => sdk.replaceEndedSession('lost-thread')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    expect(transport.connections).toHaveLength(2);
    await session.dispose();
    expect(await sdk.peekSessionStatus('lost-thread')).toBeNull();
    await sdk.close();
  });
});

describe('SDK ended ownership rotation', () => {
  async function ended(id = 'claimed') {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: id, hostInstructions: 'Host text.' });
    return { transport, sdk, session };
  }

  it('returns a new offline handle on the same Provider identity and retires the old object', async () => {
    const { transport, sdk, session } = await ended();
    await session.close('done');
    const replacement = sdk.replaceEndedSession(session.sessionId);
    expect(replacement).not.toBe(session);
    expect(sdk.getSession(session.sessionId)).toBe(replacement);
    expect(replacement.getStatus()).toBe('ended');
    expect(transport.connections).toHaveLength(1);
    for (const key of ['providerSessionId', 'provider', 'model', 'effort', 'workdir', 'artifactDirectory', 'providerStateDirectory', 'hostInstructions'] as const) expect(replacement[key]).toBe(session[key]);
    expect(replacement.tools).toEqual(session.tools);

    expect(session.isRetired()).toBe(true);
    await expect(session.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    await expect(session.sendText('stale', { turnId: 'stale' })).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });

    await replacement.resume();
    expect(replacement.getStatus()).toBe('idle');
    const opened = transport.connections[1]!;
    expect(opened.count('openSession')).toBe(0);
    expect(opened.last('rehydrateSession')!.input!.providerSessionId).toBe(session.providerSessionId);
    await sdk.close();
  });

  it('keeps the FIFO position of the replaced handle', async () => {
    const { sdk, session } = await ended('front');
    await session.close('done');
    for (let i = 0; i < 49; i++) await (await sdk.createSession({ ...base, sessionId: `behind-${i}` })).close('done');
    const replacement = sdk.replaceEndedSession('front');
    await (await sdk.createSession({ ...base, sessionId: 'pushes-out' })).close('done');
    expect(await sdk.peekSessionStatus('front')).toBeNull();
    await expect(replacement.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    expect(await sdk.peekSessionStatus('behind-0')).toBe('ended');
    await sdk.close();
  });

  it('stops the Worker of a Provider-closed handle before the successor contacts the Provider', async () => {
    const { transport, sdk, session } = await ended();
    const first = transport.connections[0]!;
    first.push('terminal', { status: 'closed' });
    await waitFor(() => session.getStatus() === 'ended');
    await settle();
    expect(first.shutdownCount).toBe(0);
    const replacement = sdk.replaceEndedSession(session.sessionId);
    await replacement.resume();
    expect(first.shutdownCount).toBe(1);
    expect(transport.connections[1]!.count('rehydrateSession')).toBe(1);
    await sdk.close();
  });

  it('lets exactly one claimant through, and refuses while a resume is in flight', async () => {
    const { sdk, session } = await ended();
    await session.close('done');
    const first = sdk.replaceEndedSession(session.sessionId);
    const resuming = first.resume();
    expect(() => sdk.replaceEndedSession(session.sessionId)).toThrow(expect.objectContaining({ code: 'DUPLICATE_SESSION' }));
    await resuming;
    expect(() => sdk.replaceEndedSession(session.sessionId)).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    await sdk.close();
  });

  it('refuses idle, busy, unknown, unavailable and evicted Sessions without touching them', async () => {
    const { transport, sdk, session } = await ended('live-idle');
    expect(() => sdk.replaceEndedSession('live-idle')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    expect(session.getStatus()).toBe('idle');
    session.onTool('updateScript', () => ({ success: true, result: null }));
    await session.sendText('work', { turnId: 't' });
    expect(() => sdk.replaceEndedSession('live-idle')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    transport.connections[0]!.push('terminal', { turnId: 't', status: 'failed' });
    await waitFor(() => session.getStatus() === 'outcome-unknown');
    expect(() => sdk.replaceEndedSession('live-idle')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    expect(() => sdk.replaceEndedSession('never-existed')).toThrow(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
    await sdk.close();
    expect(() => sdk.replaceEndedSession('live-idle')).toThrow(expect.objectContaining({ code: 'CLIENT_CLOSED' }));
  });
});

describe('Monitor tap', () => {
  async function monitored() {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const events: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { events.push(event); });
    const session = await sdk.createSession(base);
    const connection = transport.connections[0]!;
    const seen = { calls: 0, outcomes: [] as PedelecTurnOutcome[] };
    session.onTool('updateScript', () => { seen.calls += 1; return { success: true, result: { saved: true } }; });
    session.onTurnEnded((outcome) => { seen.outcomes.push(outcome); });
    return { sdk, session, connection, events, seen };
  }

  it('reports identity, send acceptance, tool correlation and the terminal as separate facts', async () => {
    const { session, connection, events, seen } = await monitored();
    await session.sendText('prompt', { turnId: 't' });
    const accepted = events.findIndex((event) => event.kind === 'turn.accepted');
    expect(accepted).toBeGreaterThan(-1);
    expect(events.some((event) => event.kind === 'turn.ended')).toBe(false);
    connection.push('turn', { type: 'started', providerTurnId: 'p' });
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: { n: 1 } });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('turn', { type: 'assistant-message', text: 'done' });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    await settle();
    expect(events[0]).toMatchObject({ kind: 'session.opened', layer: 'session', sessionId: session.sessionId, data: { model: 'gpt-test', providerSessionId: session.providerSessionId } });
    expect(events[0]).not.toHaveProperty('scope');
    expect(events[0]!.data).not.toHaveProperty('role');
    const toolKinds = events.filter((event) => event.layer === 'tool').map((event) => event.kind);
    expect(toolKinds).toEqual(['tool.request', 'tool.handler-started', 'tool.handler-finished', 'tool.reply-attempted', 'tool.reply-acknowledged']);
    for (const event of events.filter((entry) => entry.layer === 'tool')) {
      expect(event).toMatchObject({ turnId: 't', data: { toolCallId: 'c' } });
    }
    expect(events.find((event) => event.kind === 'turn.ended')).toMatchObject({ data: { terminal: 'completed' } });
    expect(connection.count('toolReply')).toBe(1);
  });

  it('a throwing or rejecting observer cannot change tool, ACK or fault behaviour', async () => {
    const { sdk, session, connection, seen } = await monitored();
    sdk.onMonitorEvent(() => { throw new Error('observer'); });
    sdk.onMonitorEvent((async () => { throw new Error('observer'); }) as never);
    const statuses: string[] = [];
    session.onStatus((status) => { statuses.push(status); });
    await session.sendText('go', { turnId: 't' });
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    expect(seen.outcomes[0]!.terminal).toBe('completed');
    expect(seen.calls).toBe(1);
    await session.sendText('again', { turnId: 't2' });
    connection.emit('crash', {});
    connection.push('tool-request', { turnId: 't2', toolCallId: 'd', toolName: 'updateScript', args: {} });
    await settle();
    expect(seen.calls).toBe(1);
    expect(connection.count('toolReply')).toBe(1);
    expect(session.getStatus()).toBe('outcome-unknown');
    expect(statuses.at(-1)).toBe('outcome-unknown');
  });

  it('never mutates or exposes live objects and only sends frames the session itself sent', async () => {
    const { session, connection, events, seen } = await monitored();
    await session.sendText('go', { turnId: 't' });
    const args = { nested: { value: 1 } };
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => seen.outcomes.length === 1);
    const request = events.find((event) => event.kind === 'tool.request')!;
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.data).not.toHaveProperty('args');
    args.nested.value = 2;
    expect(request.data).toMatchObject({ toolCallId: 'c', toolName: 'updateScript' });
    expect(connection.calls.map((call) => call.method)).toEqual(['openSession', 'send', 'toolReply']);
  });

  it('reports a fault only after the state machine latched it, including dropped late frames', async () => {
    const { session, connection, events } = await monitored();
    await session.sendText('go', { turnId: 't' });
    connection.emit('crash', {});
    connection.push('tool-request', { turnId: 't', toolCallId: 'c', toolName: 'updateScript', args: {} });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => events.some((event) => event.kind === 'turn.ended'));
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf('session.faulted')).toBeLessThan(kinds.lastIndexOf('session.status'));
    expect(events.find((event) => event.kind === 'turn.ended')).toMatchObject({ data: { terminal: 'unknown' } });
    expect(kinds).not.toContain('tool.request');
    expect(events.filter((event) => event.kind === 'transport.frame').map((event) => (event.data as { droppedByFault: boolean }).droppedByFault)).toEqual([true, true]);
    expect(session.getStatus()).toBe('outcome-unknown');
  });

  it('unsubscribes, bounds large values and costs nothing without a listener', async () => {
    const { sdk, session, connection, events } = await monitored();
    const before = events.length;
    const off = sdk.onMonitorEvent(() => undefined);
    off();
    await session.sendText('x'.repeat(40_000), { turnId: 't' });
    const send = events.find((event) => event.kind === 'turn.send')!;
    expect(send.data).not.toHaveProperty('text');
    expect(send.data).toMatchObject({ bytes: 40_000 });
    expect(events.length).toBeGreaterThan(before);
    connection.emit('monitor', { kind: 'worker.stderr', bytes: 12 });
    expect(events.at(-1)).toMatchObject({ kind: 'worker.stderr', layer: 'worker', data: { bytes: 12 } });
  });
});

describe('Tool-first Pedelec parity: dynamic registration', () => {
  it('supports zero-tool sessions and arbitrary tool sets larger than three', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const none = await sdk.createSession({ ...base, tools: [] });
    expect(none.tools).toHaveLength(0);
    await expect(none.sendText('No tools needed', { turnId: 'zero-turn' })).resolves.toMatchObject({ accepted: true });
    const tools = ['alpha', 'beta', 'gamma', 'delta'].map(name =>
      defineTool({ name, description: 'Host defined ' + name, argsSchema: { type: 'object' } }));
    const session = await sdk.createSession({ ...base, tools, hostInstructions: 'Only host-owned context.' });
    expect(session.tools.map(tool => tool.name)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(transport.connections[1]?.last('openSession')?.input).toMatchObject({
      hostInstructions: expect.stringContaining('Only host-owned context.'),
      tools: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }, { name: 'delta' }],
    });
    await expect(sdk.createSession({ ...base, tools: Array.from({ length: 65 }, (_, i) =>
      defineTool({ name: 'tool' + i, description: 'Generic tool', argsSchema: { type: 'object' } })) }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await sdk.close();
  });

  it('allows two different tool calls in one turn but never repeats the same call id', async () => {
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const tools = ['alpha', 'beta'].map(name =>
      defineTool({ name, description: 'Generic tool', argsSchema: { type: 'object' } }));
    const session = await sdk.createSession({ ...base, tools });
    const observed: string[] = [];
    const outcomes: PedelecTurnOutcome[] = [];
    for (const tool of tools) session.onTool(tool.name, () => {
      observed.push(tool.name);
      return { success: true, result: { tool: tool.name } };
    });
    session.onTurnEnded(result => { outcomes.push(result); });
    const connection = transport.connections[0]!;
    await session.sendText('Use both tools.', { turnId: 'multi-turn' });
    connection.push('tool-request', { turnId: 'multi-turn', toolCallId: 'c1', toolName: 'alpha', args: {} });
    await waitFor(() => connection.count('toolReply') === 1);
    connection.push('tool-request', { turnId: 'multi-turn', toolCallId: 'c2', toolName: 'beta', args: {} });
    await waitFor(() => connection.count('toolReply') === 2);
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => outcomes.length === 1);
    expect(observed).toEqual(['alpha', 'beta']);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [
      { toolCallId: 'c1', toolName: 'alpha', state: 'acknowledged' },
      { toolCallId: 'c2', toolName: 'beta', state: 'acknowledged' },
    ] });
    await sdk.close();
  });
});


describe('P06 provider admission boundaries', () => {
  it.each(['claude','opencode','cursor','ollama','antigravity'])('gives %s Host tools the shared CLI guidance, not a native registration', async (provider) => {
    const transport = fakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async () => {
      const connection = await connect();
      transport.connections.at(-1)!.openData = { provider, runtimeStarted: true, providerSessionId: 'native-session', capabilities: { send: 'supported' } };
      return connection;
    };
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, provider, sessionId: 'session-1' });
    const opened = transport.connections[0]!.last('openSession')!.input!;
    expect(opened.hostInstructions).toContain('pedelec-cli --thread-id session-1 tool-spec updateScript');
    expect(opened.hostInstructions).toContain(`pedelec-cli --thread-id session-1 tool-call updateScript '<json_args>'`);
    expect(opened.hostInstructions).toContain('If none of those Host tools supports the operation you need');
    expect(opened.hostInstructions).toContain('provider-native capabilities (such as shell, filesystem, or web tools) directly');
    expect(opened.hostInstructions).toContain('Native capabilities do not require pedelec-cli');
    expect(opened.hostInstructions).toContain('must not be used to bypass a Host tool denial or failed/unknown outcome');
    if (process.platform === 'win32') {
      expect(opened.hostInstructions).toContain('PowerShell 7+');
      expect(opened.hostInstructions).toContain(String.raw`'{"value":"x"}'`);
      expect(opened.hostInstructions).toContain(String.raw`'{\"value\":\"x\"}'`);
    }
    expect(session.capabilities.hostTools).toBe(false);
    await sdk.close();
  });

  it.each(['claude','opencode','cursor','ollama'])('allows %s tool-free only after runtime confirmation', async (provider) => {
    const transport = fakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async () => {
      const connection = await connect();
      transport.connections.at(-1)!.openData = { provider, runtimeStarted: true, providerSessionId: 'native-session', capabilities: { send: 'supported' } };
      return connection;
    };
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, provider, tools: [] });
    expect(session.provider).toBe(provider);
    await sdk.close();
    transport.connections.at(-1)!.openData = null;
  });

  it('rejects a missing runtime confirmation and cleans the connection', async () => {
    const transport = fakeTransport();
    const connect = transport.connect.bind(transport);
    transport.connect = async () => {
      const connection = await connect();
      transport.connections.at(-1)!.openData = { provider: 'claude', providerSessionId: 'fake' };
      return connection;
    };
    const sdk = await runtime({ transport });
    await expect(sdk.createSession({ ...base, provider: 'claude', tools: [] })).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    expect(transport.connections[0]!.shutdownCount).toBe(1);
  });
});

// CLI and legacy control fixtures share this exact handler authority predicate.
it('a completed callback context cannot revive when another tool runs in the same turn', async () => {
  const { session, connection, sdk } = await setup();
  let previous: import('../src/types.ts').PedelecToolContext | undefined;
  let count = 0;
  session.onTool('updateScript', (_, context) => {
    count++;
    context.assertActive();
    if (count === 1) previous = context;
    else expect(() => previous!.assertActive()).toThrow();
    return { success: true, result: null };
  });
  try {
    await session.sendText('go', { turnId: 'two-tools' });
    for (const id of ['first', 'second']) {
      connection.push('tool-request', { turnId: 'two-tools', toolCallId: id, toolName: 'updateScript', args: {} });
      await waitFor(() => connection.count('toolReply') === (id === 'first' ? 1 : 2));
      await settle();
    }
    expect(count).toBe(2);
    expect(() => previous!.assertActive()).toThrow();
  } finally { await sdk.close(); }
});

describe('SDK-ARTIFACT onArtifact landing', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  async function fixture(standalone = false) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-artifacts-')));
    dirs.push(directory);
    const runtimeStorageRoot = join(directory, '.pedelec-runtime');
    const transport = fakeTransport();
    const sdk = await runtime({ transport });
    const session = await sdk.createSession({ ...base, sessionId: 'session-1', tools: [], runtimeStorageRoot, ...(standalone ? { workdir: directory } : {}) });
    const { artifactDirectory } = session;
    const staging = join(artifactDirectory, '.pedelec-staging', 'session-1');
    mkdirSync(staging, { recursive: true });
    const landed: PedelecArtifact[] = [], errors: string[] = [], turns: (string | null)[] = [];
    session.onArtifact((artifact, context) => { landed.push(artifact); turns.push(context.turnId); });
    session.onError((error) => { errors.push(error.category); });
    const frame = (name: string, bytes: string, extra: Record<string, unknown> = {}) => {
      const stagedPath = join(staging, name);
      writeFileSync(stagedPath, bytes);
      return { turnId: 'turn-1', kind: 'image', source: 'image_generation', providerArtifactId: 'item-1', toolCallId: null, filename: name, mimeType: 'image/png; x=1',
        bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), stagedPath, ...extra };
    };
    await session.sendText('draw', { turnId: 'turn-1' });
    return { sdk, session, connection: transport.connections[0]!, frame, landed, errors, turns, staging, artifactDirectory };
  }

  it('stages and lands under the explicit SDK storage root', async () => {
    const { sdk, session, connection, frame, landed, staging, artifactDirectory } = await fixture(true);
    expect(session.artifactDirectory).toBe(artifactDirectory);
    expect(connection.calls.find((call) => call.method === 'openSession')!.input.artifactStagingDir).toBe(staging);
    connection.push('artifact', frame('a.png', 'one'));
    await waitFor(() => landed.length === 1);
    expect(landed[0]!.path).toBe(join(artifactDirectory, `${landed[0]!.id}-a.png`));
    await session.close('done');
    expect(existsSync(landed[0]!.path)).toBe(true);
    expect(existsSync(join(artifactDirectory, '.pedelec-staging'))).toBe(false);
    expect(existsSync(join(session.workdir, '.pedelec'))).toBe(false);
    await sdk.close();
  });

  it.each(['artifactDirectory', 'providerStateDirectory'])('rejects the retired public %s field', async (key) => {
    const sdk = await runtime({ transport: fakeTransport() });
    await expect(sdk.createSession({ ...base, [key]: directory })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('requires a trusted normalized absolute root', async () => {
    const sdk = await runtime({ transport: fakeTransport() });
    const { runtimeStorageRoot, ...input } = base;
    await expect(sdk.createSession(input as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(sdk.createSession({ ...base, runtimeStorageRoot: 'relative/root' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const parent = join(directory, 'host-data', 'workspaces');
    mkdirSync(parent, { recursive: true });
    const session = await sdk.createSession({ ...base, runtimeStorageRoot: join(parent, 'runtime') });
    expect(session.artifactDirectory).toContain(parent);
  });

  it('takes no business identity', async () => {
    const sdk = await runtime({ transport: fakeTransport() });
    for (const key of ['scope', 'role', 'metadata', 'taskId', 'workspaceId']) await expect(sdk.createSession({ ...base, tools: [], [key]: 'x' } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await sdk.close();
  });

  it('lands the file before notifying, once per provider item, keeping it through failure and close', async () => {
    const { sdk, session, connection, frame, landed, turns, staging, artifactDirectory } = await fixture();
    connection.push('artifact', frame('a b.png', 'one'));
    connection.push('artifact', frame('again.png', 'one'));
    await waitFor(() => !existsSync(join(staging, 'again.png')));
    expect(landed).toHaveLength(1);
    const [artifact] = landed;
    expect(artifact).toMatchObject({ name: 'a_b.png', kind: 'image', mimeType: 'image/png', sizeBytes: 3, source: 'image_generation', providerArtifactId: 'item-1' });
    expect(artifact!.path).toBe(join(artifactDirectory, `${artifact!.id}-a_b.png`));
    expect(readFileSync(artifact!.path, 'utf8')).toBe('one');
    expect(turns).toEqual(['turn-1']);
    connection.push('terminal', { turnId: 'turn-1', status: 'failed' });
    await waitFor(() => session.getActiveTurnId() === null);
    await session.close('done');
    expect(existsSync(artifact!.path)).toBe(true);
    expect(existsSync(join(artifactDirectory, '.pedelec-staging'))).toBe(false);
    await sdk.close();
  });

  it.each([
    ['a wrong digest', (frame: Record<string, unknown>) => ({ ...frame, sha256: '0'.repeat(64) })],
    ['a path outside staging', (frame: Record<string, unknown>) => ({ ...frame, stagedPath: join(tmpdir(), 'elsewhere.png') })],
    ['a wrong size', (frame: Record<string, unknown>) => ({ ...frame, bytes: 99 })],
    ['a foreign turn', (frame: Record<string, unknown>) => ({ ...frame, turnId: 'never-ran' })],
    ['an unreadable MIME', (frame: Record<string, unknown>) => ({ ...frame, mimeType: 'not a mime' })],
  ])('reports %s without a false notification or a session fault', async (_name, change) => {
    const { sdk, session, connection, frame, landed, errors } = await fixture();
    connection.push('artifact', change(frame('x.png', 'one')));
    await waitFor(() => errors.length === 1);
    expect(errors).toEqual(['ARTIFACT_STORAGE_FAILED']);
    expect(landed).toHaveLength(0);
    expect(session.getStatus()).toBe('busy');
    await sdk.close();
  });

  it('reports a Worker delivery failure and accepts an artifact after its turn ended', async () => {
    const { sdk, session, connection, frame, landed, errors, turns } = await fixture();
    connection.push('artifact-failed', { turnId: 'turn-1', code: 'ARTIFACT_NOT_PRODUCED' });
    await waitFor(() => errors.length === 1);
    connection.push('terminal', { turnId: 'turn-1', status: 'completed' });
    await waitFor(() => session.getActiveTurnId() === null);
    connection.push('artifact', frame('late.png', 'two'));
    await waitFor(() => landed.length === 1);
    expect(turns).toEqual(['turn-1']);
    expect(session.getStatus()).toBe('idle');
    await sdk.close();
  });
});
