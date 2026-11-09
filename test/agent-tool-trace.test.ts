import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_TOOL_TRACE_LIMITS, createPedelecRuntime, defineTool,
  type AgentToolEvent, type PedelecMonitorEvent, type PedelecTurnOutcome,
} from '../src/index.ts';
import { parseCliInvocations, stableToolCallId, TraceBounds } from '../src/agent-tool-trace.ts';
import { CliEndpoint } from '../src/transport/cli-endpoint.ts';
import { PedelecNodeSession } from '../src/session.ts';
import { fakeTransport, settle, waitFor, type FakeConnection } from './fake-transport.ts';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/agent-tool');
const updateScript = defineTool({ name: 'updateScript', description: 'Sync graph.', argsSchema: {
  type: 'object', properties: { mode: { type: 'string' } }, required: [], additionalProperties: false,
} });
const base = { runtimeStorageRoot: '', provider: 'codex' as const, model: 'gpt-test', effort: 'high', workdir: '/srv/task-1', tools: [updateScript] };

const clients: Awaited<ReturnType<typeof createPedelecRuntime>>[] = [];
const cleanup: Array<() => Promise<unknown>> = [];
let directory: string;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-trace-')));
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  for (const client of clients.splice(0)) await client.close();
  rmSync(directory, { recursive: true, force: true });
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

/** Fake Worker transport through the public runtime API (non-CLI tool path). */
async function setup(options: { provider?: 'codex' | 'claude' | 'opencode' | 'cursor' | 'antigravity' | 'ollama'; toolTrace?: unknown; detailedMonitoring?: boolean } = {}) {
  const transport = fakeTransport();
  const sdk = await createPedelecRuntime({ transport, detailedMonitoring: options.detailedMonitoring });
  clients.push(sdk);
  const provider = options.provider ?? 'codex';
  const original = transport.connect.bind(transport);
  transport.connect = async () => {
    const connection = await original() as unknown as FakeConnection;
    const receipt: Record<string, unknown> = { provider, runtimeStarted: true, providerSessionId: 'thread-x', capabilities: { send: 'supported' } };
    if (options.toolTrace !== undefined) receipt.toolTrace = options.toolTrace;
    connection.openData = receipt;
    return connection as never;
  };
  const session = await sdk.createSession({ ...base, provider, runtimeStorageRoot: join(directory, randomUUID()) });
  const connection = transport.connections[0]!;
  session.onTool('updateScript', () => ({ success: true, result: { accepted: true } }));
  return { sdk, session, connection };
}

function collect(session: PedelecNodeSession): AgentToolEvent[] {
  const events: AgentToolEvent[] = [];
  session.onAgentToolEvent((event) => { events.push(event); });
  return events;
}

const supported = { coverage: 'supported', adapter: 'test', version: 1 };
const native = (over: Record<string, unknown>) => ({
  phase: 'started', turnId: 'turn-1', nativeToolCallId: 'n1', toolName: 'commandExecution', toolKind: 'shell', status: 'running',
  input: { command: 'echo hi' }, unavailable: [], truncated: false, at: '2026-11-09T00:00:00.000Z', ...over,
});

function workerFixture(provider: string, sessionId: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, `${provider}.worker.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line.replaceAll('{{SESSION_ID}}', sessionId)));
}

const byNative = (events: AgentToolEvent[], id: string) => events.filter((e) => e.nativeToolCallId === id);

describe('TRACE-01 public API and read-only events', () => {
  it('exports session.onAgentToolEvent; events are frozen, transport-free and unsubscribe works', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const seen: AgentToolEvent[] = [];
    const off = session.onAgentToolEvent((event) => { seen.push(event); });
    const second = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({}));
    await waitFor(() => seen.length === 1 && second.length === 1);
    const event = seen[0]!;
    expect(event).toMatchObject({
      sessionId: session.sessionId, turnId: 'turn-1', provider: 'codex', source: 'provider-native', kind: 'started',
      nativeToolCallId: 'n1', toolName: 'commandExecution', toolKind: 'shell', status: 'running', coverage: 'supported', sequence: 1,
    });
    expect(event.toolCallId).toMatch(/^native:/);
    expect(event.toolCallId).not.toBe('n1');
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.input)).toBe(true);
    expect(() => { (event as { status: string }).status = 'completed'; }).toThrow(TypeError);
    expect(second[0]).toBe(event);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    for (const value of Object.values(event)) expect(typeof value).not.toBe('function');
    off();
    connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0 }));
    await waitFor(() => second.length === 2);
    expect(seen).toHaveLength(1);
    expect(() => session.onAgentToolEvent('nope' as never)).toThrow(TypeError);
    expect(AGENT_TOOL_TRACE_LIMITS).toMatchObject({ queuePerListener: 256, commandBytes: 4096, stdoutBytes: 8192, stderrBytes: 8192, inputBytes: 16384, outputBytes: 24576, eventBytes: 65536 });
    expect(AGENT_TOOL_TRACE_LIMITS).not.toHaveProperty('maxRecords');
  });

  it('works without detailedMonitoring and leaves onMonitorEvent unchanged', async () => {
    const { sdk, session, connection } = await setup({ toolTrace: supported });
    const monitor: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { monitor.push(event); });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({}));
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle' && events.length >= 1);
    await settle();
    expect(events.map((e) => e.kind)).toEqual(['started']);
    expect(monitor.some((e) => e.kind === 'turn.ended')).toBe(true);
    // Metadata-only monitor: the frame kind is visible, its tool payload is not.
    expect(JSON.stringify(monitor)).not.toContain('echo hi');
  });
});

describe('TRACE-02 event-first lifecycle, identity, no dedupe, no synthetic terminal (fake provider)', () => {
  it('delivers every Provider frame in order: duplicates repeat, only-finished stands alone, Turn end adds nothing', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    const turnEnded: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { turnEnded.push(outcome); });
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({}));
    connection.push('agent-tool', native({})); // the Provider really sent it twice
    connection.push('agent-tool', native({ phase: 'updated', output: { output: 'partial' } }));
    connection.push('agent-tool', native({ phase: 'finished', status: 'failed', exitCode: 2, output: { output: 'boom' } }));
    connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0 })); // conflicting second terminal: delivered as reported
    connection.push('agent-tool', native({ nativeToolCallId: 'only-finished', phase: 'finished', status: 'denied', unavailable: ['exitCode'] }));
    connection.push('agent-tool', native({ nativeToolCallId: 'n-cancel', phase: 'finished', status: 'cancelled' }));
    connection.push('agent-tool', native({ nativeToolCallId: 'never-finished' }));
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => turnEnded.length === 1);
    await settle();
    const n1 = byNative(events, 'n1');
    expect(n1.map((e) => [e.kind, e.status, e.exitCode])).toEqual([
      ['started', 'running', undefined], ['started', 'running', undefined], ['updated', 'running', undefined],
      ['finished', 'failed', 2], ['finished', 'completed', 0],
    ]);
    // Stable identity without any SDK table: same Session + Turn + native id.
    expect(new Set(n1.map((e) => e.toolCallId))).toEqual(new Set([stableToolCallId('provider-native', session.sessionId, 'turn-1', 'n1')]));
    expect(n1.every((e) => e.coverage === 'supported')).toBe(true);
    const finishedOnly = byNative(events, 'only-finished');
    expect(finishedOnly).toHaveLength(1);
    expect(finishedOnly[0]).toMatchObject({ kind: 'finished', status: 'denied', unavailable: ['exitCode'] });
    expect(finishedOnly[0]).not.toHaveProperty('exitCode');
    expect(byNative(events, 'n-cancel')[0]).toMatchObject({ status: 'cancelled' });
    // The Turn completed; the Tool never reported a result, so the SDK reports nothing more for it.
    expect(byNative(events, 'never-finished').map((e) => e.kind)).toEqual(['started']);
    expect(events.some((e) => e.errorCode === 'TOOL_RESULT_NOT_OBSERVED' || e.status === 'unknown')).toBe(false);
    expect(turnEnded[0]!.terminal).toBe('completed');
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => !('detailRedacted' in e))).toBe(true);
  });

  it('a late Provider result after its Turn ended is delivered once, marked lateObservation, and never touches the next Turn', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: 'slow' }));
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    await session.sendText('again', { turnId: 'turn-2' });
    connection.push('agent-tool', native({ nativeToolCallId: 'slow', phase: 'finished', status: 'completed', exitCode: 0 }));
    connection.push('agent-tool', native({ turnId: 'turn-2', nativeToolCallId: 'slow' })); // same native id, other Turn
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle' && events.length >= 3);
    await settle();
    const slow = byNative(events, 'slow');
    const turn1 = slow.filter((e) => e.turnId === 'turn-1');
    const turn2 = slow.filter((e) => e.turnId === 'turn-2');
    expect(turn1.map((e) => [e.kind, e.status, e.lateObservation ?? false])).toEqual([
      ['started', 'running', false], ['finished', 'completed', true],
    ]);
    expect(turn1[0]!.toolCallId).toBe(turn1[1]!.toolCallId);
    expect(turn2).toHaveLength(1);
    expect(turn2[0]!.toolCallId).not.toBe(turn1[0]!.toolCallId);
    expect(turn2[0]!.lateObservation).toBeUndefined();
  });

  it('never merges across Sessions; foreign or missing Turns are never merged on null', async () => {
    const a = await setup({ toolTrace: supported });
    const b = await setup({ toolTrace: supported });
    const ea = collect(a.session);
    const eb = collect(b.session);
    await a.session.sendText('go', { turnId: 'turn-1' });
    await b.session.sendText('go', { turnId: 'turn-1' });
    a.connection.push('agent-tool', native({}));
    b.connection.push('agent-tool', native({}));
    a.connection.push('agent-tool', native({ turnId: 'turn-elsewhere', nativeToolCallId: 'foreign' }));
    a.connection.push('agent-tool', native({ turnId: 'turn-other', nativeToolCallId: 'foreign', phase: 'finished', status: 'completed' }));
    a.connection.push('agent-tool', native({ turnId: null, nativeToolCallId: 'foreign', unavailable: ['turnId'] }));
    await waitFor(() => ea.length === 4 && eb.length === 1);
    expect(ea[0]!.toolCallId).not.toBe(eb[0]!.toolCallId);
    expect(ea[0]!.sessionId).toBe(a.session.sessionId);
    expect(eb[0]!.sessionId).toBe(b.session.sessionId);
    const foreign = ea.slice(1);
    expect(foreign.every((e) => e.turnId === null && e.coverage === 'partial' && e.unavailable?.includes('turnId'))).toBe(true);
    expect(new Set(foreign.map((e) => e.toolCallId)).size).toBe(3);
  });

  it('a call without a native id gets its own id per event and is never merged by name or time', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: null, unavailable: ['nativeToolCallId'] }));
    connection.push('agent-tool', native({ nativeToolCallId: null, phase: 'finished', status: 'completed', unavailable: ['nativeToolCallId'] }));
    await waitFor(() => events.length === 2);
    expect(events[0]!.toolCallId).not.toBe(events[1]!.toolCallId);
    expect(events.every((e) => e.coverage === 'partial' && e.unavailable?.includes('nativeToolCallId'))).toBe(true);
    expect(events.every((e) => !('nativeToolCallId' in e))).toBe(true);
  });

  it('the SDK keeps no Tool Record state: 4,150 started-only calls leave nothing to grow', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    for (let i = 0; i < 4150; i += 1) connection.push('agent-tool', native({ nativeToolCallId: `s-${i}` }));
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    await settle();
    const tracer = (session as unknown as { trace: Record<string, unknown> }).trace;
    // Only Session-level scalars and the dispatcher: no Map/Set of records exists to grow.
    for (const value of Object.values(tracer)) expect(value instanceof Map || value instanceof Set).toBe(false);
    expect(events.filter((e) => e.kind === 'started').length + events.filter((e) => e.kind === 'observation-gap').reduce((n, e) => n + (e.droppedEvents ?? 0), 0)).toBe(4150);
    expect(events.some((e) => e.kind === 'finished')).toBe(false);
  });
});

describe('TRACE-03 provider fixtures replay Worker golden output through the SDK', () => {
  async function replay(provider: 'codex' | 'claude' | 'opencode' | 'cursor' | 'antigravity', toolTrace: unknown = supported) {
    const { session, connection } = await setup({ provider, toolTrace });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    for (const frame of workerFixture(provider, session.sessionId)) connection.push('agent-tool', frame);
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => session.getStatus() === 'idle');
    await settle();
    // 01A raw fidelity: fake canaries the Worker forwarded reach the listener unchanged.
    const text = JSON.stringify(events);
    expect(text).not.toContain('[REDACTED');
    expect(events.every((e) => !('detailRedacted' in e))).toBe(true);
    return { session, events, text };
  }

  it('Codex: shell exit codes, combined output, file/MCP/search tools, decline, unknown item and dedupe', async () => {
    const { events, text } = await replay('codex');
    for (const canary of ['sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456', 'sk-test-SECRET99999999999', '/Users/alice/work/task-1']) expect(text).toContain(canary);
    const ok = byNative(events, 'call_ok');
    expect(ok.map((e) => e.kind)).toEqual(['started', 'finished']);
    expect(ok[1]).toMatchObject({ status: 'completed', exitCode: 0, output: { output: 'trace-ok\n', combinedStreams: true } });
    expect(ok[1]!.unavailable).toEqual(expect.arrayContaining(['stdout', 'stderr']));
    expect(ok[0]!.input).toMatchObject({ cwd: '/Users/alice/work/task-1' });
    // The Provider sent the failed completion twice; both are delivered (event-first, no SDK dedupe).
    expect(byNative(events, 'call_fail').map((e) => [e.kind, e.status, e.exitCode])).toEqual([['started', 'running', undefined], ['finished', 'failed', 1], ['finished', 'failed', 1]]);
    expect(byNative(events, 'call_patch')[1]).toMatchObject({ toolKind: 'file', status: 'completed' });
    expect(byNative(events, 'call_mcp')[0]).toMatchObject({ toolName: 'search_docs', toolKind: 'mcp', input: { arguments: { api_key: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456' } } });
    expect(byNative(events, 'call_web')[1]).toMatchObject({ toolKind: 'search', status: 'unknown' });
    const rm = byNative(events, 'call_rm');
    expect(rm.map((e) => [e.kind, e.status])).toEqual([['updated', 'denied'], ['finished', 'denied']]);
    expect(rm[1]!.toolName).toBe('commandExecution');
    expect(byNative(events, 'call_future')[0]).toMatchObject({ toolKind: 'unknown', toolName: 'futureTool', errorCode: 'PROVIDER_ITEM_UNCLASSIFIED' });
    const secret = byNative(events, 'call_secret');
    expect(JSON.stringify(secret[0]!.input)).toContain('sk-test-SECRET99999999999');
    // Only-finished is delivered as is (no SDK record to say a start was missing).
    expect(byNative(events, 'call_orphan').map((e) => e.kind)).toEqual(['finished']);
    // Started, never finished: nothing is synthesised at Turn end.
    expect(byNative(events, 'call_hang').map((e) => e.kind)).toEqual(['started']);
    const cli = byNative(events, 'call_cli');
    expect(cli[0]!.hostInvocations).toEqual([{ subcommand: 'tool-call', toolName: 'updateScript' }]);
  });

  it('Claude: tool_use/tool_result pairing, no invented exit code, sub-agent parent, interrupt and orphan result', async () => {
    const { events, text } = await replay('claude');
    expect(text).toContain('plain-secret-value');
    const ok = byNative(events, 'toolu_ok');
    expect(ok[1]).toMatchObject({ status: 'completed', output: { stdout: 'trace-ok', stderr: '' } });
    expect(ok[1]).not.toHaveProperty('exitCode');
    expect(ok[1]!.unavailable).toContain('exitCode');
    expect(byNative(events, 'toolu_fail').map((e) => e.kind)).toEqual(['started', 'started', 'finished']);
    expect(byNative(events, 'toolu_fail')[2]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_TOOL_ERROR' });
    expect(byNative(events, 'toolu_read')[0]).toMatchObject({ toolName: 'Read', toolKind: 'file' });
    expect(byNative(events, 'toolu_grep')[0]).toMatchObject({ toolName: 'Grep', toolKind: 'search' });
    const task = byNative(events, 'toolu_task')[0]!;
    expect(byNative(events, 'toolu_child')[0]!.parentToolCallId).toBe(task.toolCallId);
    expect(byNative(events, 'toolu_sleep')[1]!.status).toBe('cancelled');
    expect(byNative(events, 'toolu_never_started')[0]).toMatchObject({ toolName: 'unknown', toolKind: 'unknown' });
    expect(byNative(events, 'toolu_never_started')[0]!.unavailable).toContain('toolName');
    expect(byNative(events, 'toolu_secret')[1]!.output).toMatchObject({ stdout: expect.stringContaining('BEGIN') });
    expect(byNative(events, 'toolu_hang').map((e) => e.kind)).toEqual(['started']);
  });

  it('OpenCode: ACP ids, kinds, reported exit, permission denial and anonymous call', async () => {
    const { events } = await replay('opencode');
    expect(byNative(events, 'call_ok').map((e) => e.kind)).toEqual(['started', 'updated', 'finished']);
    expect(byNative(events, 'call_ok')[2]).toMatchObject({ toolName: 'bash', exitCode: 0, status: 'completed' });
    expect(byNative(events, 'call_fail')[1]).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(byNative(events, 'call_rm').map((e) => e.status)).toEqual(['running', 'denied', 'failed']);
    expect(events.find((e) => e.toolKind === 'browser')).toMatchObject({ coverage: 'partial' });
  });

  it('Cursor: separate parser, exit code and stdout honestly unavailable, cancelled prompt is a denial', async () => {
    const { events } = await replay('cursor');
    const ok = byNative(events, 'tool_ok');
    expect(ok[0]).toMatchObject({ toolName: 'execute', toolKind: 'shell' });
    expect(ok.at(-1)).toMatchObject({ status: 'completed' });
    expect(ok.at(-1)!.unavailable).toContain('exitCode');
    expect(byNative(events, 'tool_cli')[0]!.hostInvocations).toEqual([{ subcommand: 'tool-call', toolName: 'updateScript' }]);
    expect(byNative(events, 'tool_rm').map((e) => e.status)).toContain('denied');
  });

  it('Antigravity: declared unsupported; steps are evidence only, never tool records', async () => {
    const { events } = await replay('antigravity', { coverage: 'unsupported', adapter: 'antigravity-step-update-unclassified', version: 1 });
    expect(events.every((e) => e.kind === 'observation-gap')).toBe(true);
    expect(events[0]).toMatchObject({ errorCode: 'PROVIDER_TRACE_UNSUPPORTED', coverage: 'unsupported', turnId: 'turn-1' });
    expect(events[1]).toMatchObject({ errorCode: 'PROVIDER_STEPS_UNCLASSIFIED', coverage: 'unsupported', output: { unclassifiedStepTypes: { run_command: 2 } } });
  });
});

describe('TRACE-04 coverage declarations', () => {
  it.each([
    [{ coverage: 'unsupported' }, 'PROVIDER_TRACE_UNSUPPORTED', 'unsupported'],
    [undefined, 'PROVIDER_TRACE_COVERAGE_UNKNOWN', 'unknown'],
    [{ coverage: 'made-up' }, 'PROVIDER_TRACE_COVERAGE_UNKNOWN', 'unknown'],
  ])('receipt %j opens every Turn with an explicit gap', async (toolTrace, code, coverage) => {
    const { session } = await setup({ provider: 'ollama', toolTrace });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ kind: 'observation-gap', errorCode: code, coverage, turnId: 'turn-1' });
  });

  it('a supported adapter adds no gap, but events from a non-supported Session are never labelled supported', async () => {
    const ok = await setup({ toolTrace: supported });
    const okEvents = collect(ok.session);
    await ok.session.sendText('go', { turnId: 'turn-1' });
    await settle();
    expect(okEvents).toEqual([]);
    const unknown = await setup({});
    const events = collect(unknown.session);
    await unknown.session.sendText('go', { turnId: 'turn-1' });
    unknown.connection.push('agent-tool', native({}));
    await waitFor(() => events.length === 2);
    expect(events[1]!.coverage).toBe('partial');
  });
});

describe('TRACE-05 listener isolation, backpressure and gaps', () => {
  it('no listener, throwing, rejecting and never-settling listeners leave Tool ACK and Turn outcome identical', async () => {
    const outcomes: string[] = [];
    for (const mode of ['none', 'throw', 'reject', 'hang', 'reentrant'] as const) {
      const { session, connection } = await setup({ toolTrace: supported });
      if (mode === 'throw') session.onAgentToolEvent(() => { throw new Error('listener bug'); });
      if (mode === 'reject') session.onAgentToolEvent(async () => { throw new Error('async listener bug'); });
      if (mode === 'hang') session.onAgentToolEvent(() => new Promise<void>(() => {}));
      if (mode === 'reentrant') {
        const offs: Array<() => void> = [];
        session.onAgentToolEvent(() => { offs.push(session.onAgentToolEvent(() => { throw new Error('nested'); })); offs.shift()?.(); });
      }
      const ended: PedelecTurnOutcome[] = [];
      session.onTurnEnded((outcome) => { ended.push(outcome); });
      await session.sendText('go', { turnId: 'turn-1' });
      connection.push('agent-tool', native({}));
      connection.push('tool-request', { turnId: 'turn-1', toolCallId: 'host-1', toolName: 'updateScript', args: { mode: 'sync' } });
      connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0 }));
      connection.push('terminal', { status: 'completed' });
      await waitFor(() => ended.length === 1);
      expect(connection.count('toolReply')).toBe(1);
      outcomes.push(JSON.stringify([ended[0]!.terminal, ended[0]!.toolCalls, session.getStatus()]));
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(JSON.parse(outcomes[0]!)[0]).toBe('completed');
  });

  it('a slow listener loses only its own events and is told exactly which, in order', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const slow: AgentToolEvent[] = [];
    session.onAgentToolEvent(async (event) => { slow.push(event); if (slow.length === 1) await gate; });
    const fast = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    const total = AGENT_TOOL_TRACE_LIMITS.queuePerListener + 100;
    for (let i = 0; i < total; i += 1) connection.push('agent-tool', native({ nativeToolCallId: `burst-${i}`, phase: 'finished', status: 'completed' }));
    await waitFor(() => fast.length === total);
    release();
    await waitFor(() => slow.some((e) => e.kind === 'observation-gap'));
    await settle();
    const gap = slow.find((e) => e.kind === 'observation-gap')!;
    expect(gap).toMatchObject({ errorCode: 'LISTENER_QUEUE_OVERFLOW', coverage: 'partial' });
    const delivered = slow.filter((e) => e.kind !== 'observation-gap').length;
    expect(delivered + gap.droppedEvents!).toBe(total);
    expect(gap.droppedSequences!.last - gap.droppedSequences!.first + 1).toBe(gap.droppedEvents);
    // The gap sits exactly where the missing events would have been.
    const index = slow.indexOf(gap);
    expect(slow[index - 1]!.sequence).toBe(gap.droppedSequences!.first - 1);
    expect(fast.every((e) => e.kind !== 'observation-gap')).toBe(true);
    expect(fast.map((e) => e.sequence)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('a listener is never called synchronously from the Session path', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    let inListener = false;
    let pushReturned = false;
    session.onAgentToolEvent(() => { inListener = true; expect(pushReturned).toBe(true); });
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({}));
    pushReturned = true;
    await waitFor(() => inListener);
  });
});

describe('TRACE-06 raw fidelity (no redaction) and truncation bounds', () => {
  it('fake credential and private-path canaries reach the listener unchanged when untruncated', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    const canary = {
      command: 'curl -H "Authorization: Bearer FAKE-canary-bearer" -H "Cookie: sid=FAKE-canary" https://u:FAKE-pw@host.invalid/x?api_key=FAKE-q && API_KEY=FAKE-env ./run /Users/canary/private.txt',
      cwd: '/Users/canary/work', headers: { Authorization: 'Bearer FAKE-header' }, password: 'FAKE-pw2', api_key: 'FAKE-key',
    };
    connection.push('agent-tool', native({ input: canary }));
    connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0, output: { stdout: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----', stderr: 'token=FAKE' } }));
    connection.push('agent-tool', native({ nativeToolCallId: 'acp', toolName: 'curl -u FAKE:pw https://x', input: { title: 'curl -u FAKE:pw https://x' } }));
    await waitFor(() => events.length === 3);
    expect(events[0]!.input).toEqual(canary);
    expect(events[1]!.output).toEqual({ stdout: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----', stderr: 'token=FAKE' });
    expect(events[2]).toMatchObject({ toolName: 'curl -u FAKE:pw https://x', input: { title: 'curl -u FAKE:pw https://x' } });
    for (const event of events) {
      expect(event.detailTruncated).toBeUndefined();
      expect(event).not.toHaveProperty('detailRedacted');
    }
  });

  it('truncates long command/stdout/stderr/args, nested and wide objects, and whole events, always marked', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) deep = { d: deep };
    connection.push('agent-tool', native({ input: { command: 'c'.repeat(5000), deep, wide: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])) } }));
    connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0, output: { stdout: 'A'.repeat(20_000), stderr: 'E'.repeat(9000) } }));
    connection.push('agent-tool', native({ nativeToolCallId: 'huge', input: { command: 'x', blobs: Array.from({ length: 60 }, () => 'B'.repeat(4000)) } }));
    connection.push('agent-tool', native({ nativeToolCallId: 'worker-cut', truncated: true, input: { command: 'cut upstream…[truncated 9 bytes]' } }));
    await waitFor(() => events.length === 4);
    const [started, finished, huge, workerCut] = events as [AgentToolEvent, AgentToolEvent, AgentToolEvent, AgentToolEvent];
    const input = started.input as { command: string; deep: unknown; wide: Record<string, number> };
    expect(started.detailTruncated).toBe(true);
    expect(input.command).toMatch(/^c{4096}…\[truncated 904 bytes\]$/);
    expect(JSON.stringify(input.deep)).toContain('[max-depth]');
    expect(Object.keys(input.wide)).toHaveLength(AGENT_TOOL_TRACE_LIMITS.maxEntries);
    const output = finished.output as { stdout: string; stderr: string };
    expect(finished.detailTruncated).toBe(true);
    expect(Buffer.byteLength(output.stdout.split('…[truncated')[0]!)).toBe(AGENT_TOOL_TRACE_LIMITS.stdoutBytes);
    expect(Buffer.byteLength(output.stderr.split('…[truncated')[0]!)).toBe(AGENT_TOOL_TRACE_LIMITS.stderrBytes);
    expect(finished.exitCode).toBe(0);
    expect(huge.detailTruncated).toBe(true);
    expect(huge.input).toMatchObject({ truncated: true });
    expect(workerCut.detailTruncated).toBe(true);
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(AGENT_TOOL_TRACE_LIMITS.eventBytes);
  });

  it('bounds unit: values kept verbatim, only size is cut', () => {
    const bounds = new TraceBounds();
    const state = { truncated: false };
    expect(bounds.value({ password: 'x', api_key: 'k', path: 'C:\\Users\\bob\\x', auth: 'Basic dXNlcjpwYXNz' }, state))
      .toEqual({ password: 'x', api_key: 'k', path: 'C:\\Users\\bob\\x', auth: 'Basic dXNlcjpwYXNz' });
    expect(state.truncated).toBe(false);
    expect(bounds.text('é'.repeat(10), 5, state)).toBe('éé…[truncated 16 bytes]');
    expect(state.truncated).toBe(true);
  });
});

describe('TRACE-07 crash, fault, cancel and close: bounded gap only, never a synthetic Tool outcome or retry', () => {
  it('Worker crash ends the stream with one gap; open calls get no finished; later frames are not trusted', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({}));
    await waitFor(() => events.length === 1);
    connection.emit('crash', { code: 1 });
    await waitFor(() => events.some((e) => e.kind === 'observation-gap'));
    await settle();
    expect(events.filter((e) => e.kind === 'finished')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: 'observation-gap', errorCode: 'TRACE_STREAM_ENDED', coverage: 'partial', output: { reason: 'WORKER_CRASHED' } });
    connection.push('agent-tool', native({ phase: 'finished', status: 'completed', exitCode: 0 }));
    await settle();
    expect(events.filter((e) => e.status === 'completed')).toEqual([]);
    expect(connection.count('send')).toBe(1);
    expect(connection.count('toolReply')).toBe(0);
  });

  it('a provider error queued after observations keeps them, then reports the loss once', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: 'a' }));
    connection.push('agent-tool', native({ nativeToolCallId: 'a', phase: 'finished', status: 'completed', exitCode: 0 }));
    connection.push('agent-tool', native({ nativeToolCallId: 'b' }));
    connection.push('provider-error', { code: 'PROVIDER_DISCONNECTED' });
    await waitFor(() => events.some((e) => e.kind === 'observation-gap'));
    await settle();
    expect(byNative(events, 'a').at(-1)).toMatchObject({ status: 'completed' });
    expect(byNative(events, 'b').map((e) => e.kind)).toEqual(['started']);
    expect(events.filter((e) => e.kind === 'observation-gap')).toHaveLength(1);
  });

  it('cancel: only the Provider-reported cancellation appears; the open call gets nothing synthesised; no resend', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    const ended: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { ended.push(outcome); });
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: 'open' }));
    connection.push('agent-tool', native({ nativeToolCallId: 'stopped' }));
    await waitFor(() => events.length === 2);
    await session.cancel('user stop');
    connection.push('agent-tool', native({ nativeToolCallId: 'stopped', phase: 'finished', status: 'cancelled' }));
    connection.push('terminal', { status: 'interrupted' });
    await waitFor(() => ended.length === 1);
    await settle();
    expect(byNative(events, 'stopped').at(-1)).toMatchObject({ status: 'cancelled' });
    expect(byNative(events, 'open').map((e) => e.kind)).toEqual(['started']);
    expect(ended[0]!.terminal).toBe('unknown');
    expect(connection.count('send')).toBe(1);
  });

  it('close during a running Turn reports the interruption once; a clean idle close adds nothing', async () => {
    const idle = await setup({ toolTrace: supported });
    const idleEvents = collect(idle.session);
    await idle.session.close('done');
    await settle();
    expect(idleEvents).toEqual([]);
    const busy = await setup({ toolTrace: supported });
    const events = collect(busy.session);
    await busy.session.sendText('go', { turnId: 'turn-1' });
    busy.connection.push('agent-tool', native({}));
    await waitFor(() => events.length === 1);
    await busy.session.close('stop');
    await waitFor(() => events.length === 2);
    await settle();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'observation-gap', errorCode: 'TRACE_STREAM_ENDED', output: { reason: 'SESSION_CLOSED' } });
  });

  it('a malformed observation and a throwing normaliser never reach the Tool or Turn path', async () => {
    const { session, connection } = await setup({ toolTrace: supported });
    const events = collect(session);
    const ended: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { ended.push(outcome); });
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', { phase: 'nonsense' });
    connection.push('agent-tool', native({ input: { toJSON() { throw new Error('boom'); } } as never }));
    const poisoned = { phase: 'started' } as Record<string, unknown>;
    Object.defineProperty(poisoned, 'turnId', { get() { throw new Error('parse fault'); }, enumerable: true });
    (session as unknown as { trace: { ingestNative(d: unknown): void } }).trace.ingestNative(poisoned);
    connection.push('tool-request', { turnId: 'turn-1', toolCallId: 'host-1', toolName: 'updateScript', args: { mode: 'sync' } });
    connection.push('terminal', { status: 'completed' });
    await waitFor(() => ended.length === 1);
    await settle();
    expect(connection.count('toolReply')).toBe(1);
    expect(ended[0]!.terminal).toBe('completed');
    expect(events.some((e) => e.errorCode === 'TRACE_INSTRUMENTATION_FAILED')).toBe(true);
  });
});

describe('TRACE-08 Host Tools through the real CLI endpoint (invocation-local context, no inferred parent)', () => {
  const cliBinary = resolve('rust/target/debug', process.platform === 'win32' ? 'pedelec-cli.exe' : 'pedelec-cli');

  async function cliSetup(timeout = 2_000) {
    const id = `s-${randomUUID()}`;
    const endpoint = await CliEndpoint.start(id, [updateScript]);
    const fixture = fakeTransport();
    await fixture.connect();
    const connection = fixture.connections[0]!;
    connection.sessionId = id;
    const temporary = resolve(endpoint.runtimeFile, '..');
    const session = new PedelecNodeSession({
      sessionId: id, providerSessionId: 'provider', provider: 'codex', workdir: temporary,
      runtimeStorageRoot: resolve(temporary, 'runtime'), artifactDirectory: resolve(temporary, 'artifacts'), hostInstructions: '',
      model: 'fixture', effort: 'default', tools: [updateScript], connection: connection as never, toolTraceCoverage: 'supported',
      cliEndpoint: endpoint, cliOnly: true, sendTimeoutMs: 500, toolReplyTimeoutMs: timeout, onDisposed: () => {}, observe: () => {},
    });
    cleanup.push(() => session.dispose());
    const call = async (args: unknown, requestId = randomUUID().replaceAll('-', ''), type: 'tool_call' | 'tool_spec' = 'tool_call') => {
      const runtime = JSON.parse(await readFile(endpoint.runtimeFile, 'utf8'));
      return new Promise<Record<string, unknown>>((resolveReply, reject) => {
        const socket = createConnection({ host: runtime.host, port: runtime.port });
        let bytes = '';
        socket.on('error', reject);
        // A faulted Session destroys the socket without a reply: that is an unknown outcome, not a hang.
        socket.on('close', () => reject(new Error('CLI_SOCKET_CLOSED')));
        socket.on('data', (chunk) => { bytes += chunk; if (bytes.includes('\n')) resolveReply(JSON.parse(bytes)); });
        socket.on('connect', () => socket.write(JSON.stringify({ requestId, type, generation: runtime.generation,
          payload: type === 'tool_call' ? { threadId: id, toolName: 'updateScript', args } : { threadId: id, toolName: 'updateScript' } }) + '\n'));
      });
    };
    const shellCommand = (args: string) => `/bin/zsh -lc "pedelec-cli --thread-id ${id} tool-call updateScript '${args.replaceAll('"', '\\"')}'"`;
    return { id, endpoint, session, connection, call, shellCommand };
  }

  it('success: native Shell and Host are two sources; Host is unlinked (no trusted parent id); delivery is not a Provider ACK', async () => {
    const { session, connection, call, shellCommand } = await cliSetup();
    let effects = 0;
    session.onTool('updateScript', () => { effects += 1; return { success: true, result: { accepted: true, token: 'FAKE-result-token' } }; });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: 'shell-1', input: { command: shellCommand('{"mode":"sync"}') } }));
    await waitFor(() => events.length === 1);
    expect(await call({ mode: 'sync --api-key FAKE-arg-key' })).toMatchObject({ ok: true, result: { accepted: true } });
    connection.push('agent-tool', native({ nativeToolCallId: 'shell-1', phase: 'finished', status: 'completed', exitCode: 0 }));
    await waitFor(() => events.length === 5);
    const shell = events.find((e) => e.nativeToolCallId === 'shell-1')!;
    const host = events.filter((e) => e.source === 'pedelec-host');
    expect(host.map((e) => e.kind)).toEqual(['started', 'updated', 'finished']);
    expect(host.every((e) => e.correlation === 'unlinked' && e.parentToolCallId === undefined && e.toolKind === 'host')).toBe(true);
    expect(new Set(host.map((e) => e.toolCallId)).size).toBe(1);
    expect(host[0]!.toolCallId).toBe(stableToolCallId('pedelec-host', session.sessionId, 'turn-1', host[0]!.hostToolCallId!));
    expect(host[0]).toMatchObject({ toolName: 'updateScript', status: 'running', input: { args: { mode: 'sync --api-key FAKE-arg-key' } } });
    expect(host[0]!.hostToolCallId).toMatch(/^[0-9a-f]{32}$/);
    expect(host[1]!.output).toMatchObject({ handler: 'returned', success: true, result: { token: 'FAKE-result-token' } });
    expect(host[2]).toMatchObject({ status: 'completed', output: { delivery: 'cli-reply-written', providerAcknowledgement: 'unavailable' } });
    // Event-local hint on the native event only.
    expect(shell.hostInvocations).toEqual([{ subcommand: 'tool-call', toolName: 'updateScript' }]);
    expect(effects).toBe(1);
  });

  it('a later native Shell event never back-links or updates a Host event', async () => {
    const { session, connection, call, shellCommand } = await cliSetup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    await call({ mode: 'late' });
    await waitFor(() => events.length === 3);
    connection.push('agent-tool', native({ nativeToolCallId: 'shell-late', input: { command: shellCommand('{"mode":"late"}') } }));
    await waitFor(() => events.length === 4);
    await settle();
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.source === 'pedelec-host').every((e) => e.correlation === 'unlinked' && !e.parentToolCallId)).toBe(true);
  });

  it('tool-spec makes no Host Invocation; identical commands are not paired', async () => {
    const { session, connection, call, shellCommand } = await cliSetup();
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    connection.push('agent-tool', native({ nativeToolCallId: 'twin-a', input: { command: shellCommand('{"mode":"x"}') } }));
    connection.push('agent-tool', native({ nativeToolCallId: 'spec', input: { command: 'pedelec-cli --thread-id x tool-spec updateScript' } }));
    await waitFor(() => events.length === 2);
    expect(await call(undefined, undefined, 'tool_spec')).toMatchObject({ ok: true });
    await settle();
    expect(events.filter((e) => e.source === 'pedelec-host')).toHaveLength(0);
    await call({ mode: 'x' });
    await waitFor(() => events.filter((e) => e.source === 'pedelec-host').length === 3);
    const host = events.filter((e) => e.source === 'pedelec-host');
    expect(host.every((e) => e.correlation === 'unlinked' && e.parentToolCallId === undefined)).toBe(true);
    expect(events.find((e) => e.nativeToolCallId === 'spec')!.hostInvocations).toEqual([{ subcommand: 'tool-spec', toolName: 'updateScript' }]);
  });

  it('handler failure, reported failure, timeout and refusals are traced with distinct outcomes', async () => {
    const { session, call } = await cliSetup(150);
    let mode: 'fail' | 'throw' | 'hang' = 'fail';
    session.onTool('updateScript', () => {
      if (mode === 'fail') return { success: false, result: { why: 'nope' } };
      if (mode === 'throw') throw new Error('handler bug');
      return new Promise(() => {});
    });
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    expect(await call({ mode: 1 })).toMatchObject({ ok: false, error: { code: 'TOOL_SCHEMA_INVALID' } });
    expect(await call({ mode: 'fail' })).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED' } });
    mode = 'throw';
    await call({ mode: 'throw' }).catch(() => undefined);
    await waitFor(() => events.filter((e) => e.kind === 'finished').length === 3);
    const finished = events.filter((e) => e.kind === 'finished');
    expect(finished[0]).toMatchObject({ status: 'failed', errorCode: 'TOOL_SCHEMA_INVALID', input: { args: { mode: 1 } } });
    expect(finished[1]).toMatchObject({ status: 'failed', errorCode: 'TOOL_REPORTED_FAILURE', output: { success: false, result: { why: 'nope' } } });
    expect(finished[2]).toMatchObject({ status: 'failed', errorCode: 'TOOL_HANDLER_FAILED' });
    // The thrown handler faulted the Session exactly as before: the endpoint is closed and nothing else runs.
    await expect(call({ mode: 'after' })).rejects.toThrow();
    expect(session.getStatus()).toBe('outcome-unknown');
    expect(events.filter((e) => e.source === 'pedelec-host' && e.kind === 'started')).toHaveLength(2);
  });

  it('handler timeout is unknown, not failed or completed', async () => {
    const { session, call } = await cliSetup(100);
    session.onTool('updateScript', () => new Promise(() => {}));
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    await call({ mode: 'hang' }).catch(() => undefined);
    await waitFor(() => events.some((e) => e.kind === 'finished'));
    expect(events.find((e) => e.kind === 'finished')).toMatchObject({ status: 'unknown', errorCode: 'TOOL_TIMEOUT' });
  });

  it('cancel during a running handler is traced as cancelled; ACK is not claimed', async () => {
    const { session, call } = await cliSetup(5_000);
    let entered = false;
    session.onTool('updateScript', (_args, context) => new Promise((_resolve, reject) => {
      entered = true;
      context.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    const pending = call({ mode: 'cancel' }).catch(() => undefined);
    await waitFor(() => entered);
    await session.cancel('stop');
    await pending;
    await waitFor(() => events.some((e) => e.kind === 'finished'));
    const finished = events.find((e) => e.kind === 'finished')!;
    expect(['cancelled', 'unknown']).toContain(finished.status);
    expect(JSON.stringify(finished.output ?? {})).not.toContain('acknowledged');
  });

  it('a throwing listener never changes the Host handler, reply or ACK', async () => {
    const { session, call } = await cliSetup();
    let effects = 0;
    session.onTool('updateScript', () => { effects += 1; return { success: true, result: { ok: 1 } }; });
    session.onAgentToolEvent(() => { throw new Error('listener bug'); });
    session.onAgentToolEvent(async () => { throw new Error('async listener bug'); });
    await session.sendText('go', { turnId: 'turn-1' });
    expect(await call({ mode: 'x' })).toMatchObject({ ok: true, result: { ok: 1 } });
    expect(effects).toBe(1);
  });

  it('the real pedelec-cli binary → endpoint → onTool path is traced', async () => {
    if (!existsSync(cliBinary)) throw new Error(`build ${cliBinary} first (cargo build -p pedelec-cli)`);
    const { id, endpoint, session } = await cliSetup();
    session.onTool('updateScript', (args) => ({ success: true, result: args as never }));
    const events = collect(session);
    await session.sendText('go', { turnId: 'turn-1' });
    const { stdout } = await promisify(execFile)(cliBinary, ['--thread-id', id, 'tool-call', 'updateScript', '{"mode":"real"}'],
      { env: { ...process.env, PEDELEC_CORE_IPC_RUNTIME_FILE: endpoint.runtimeFile }, timeout: 5000 });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, result: { mode: 'real' } });
    await waitFor(() => events.some((e) => e.kind === 'finished'));
    expect(events.find((e) => e.kind === 'finished')).toMatchObject({ source: 'pedelec-host', toolName: 'updateScript', status: 'completed' });
  });
});

describe('TRACE-09 pedelec-cli command parsing', () => {
  it('finds tool-call/tool-spec across quoting, nesting, flags and control operators', () => {
    expect(parseCliInvocations(`pedelec-cli --thread-id abc tool-call t '{"a":1}'`)).toEqual([{ subcommand: 'tool-call', toolName: 't', threadId: 'abc', args: '{"a":1}' }]);
    expect(parseCliInvocations(`/bin/bash -lc "cd x && /opt/bin/pedelec-cli --thread-id=abc tool-call t '{\\"a\\": [1]}' ; pedelec-cli tool-spec u"`)).toEqual([
      { subcommand: 'tool-call', toolName: 't', threadId: 'abc', args: '{"a": [1]}' },
      { subcommand: 'tool-spec', toolName: 'u', threadId: null, args: null },
    ]);
    expect(parseCliInvocations('`pedelec-cli --thread-id s tool-call t \'{}\'`')).toHaveLength(1);
    expect(parseCliInvocations('echo pedelec-cli-helper tool-call t')).toEqual([]);
    expect(parseCliInvocations('pedelec-cli tool-call "bad name"')).toEqual([]);
  });
});
