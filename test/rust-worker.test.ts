import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPedelecRuntime, defineTool, type AgentToolEvent, type PedelecMonitorEvent, type PedelecNodeClient, type PedelecTurnOutcome } from '../src/index.ts';
import { waitFor } from './fake-transport.ts';

// Real Rust IPC v1 worker + real pedelec-cli + a fake Codex app server: the Host Tool path a Provider shell takes.
const workerPath = resolve(process.cwd(), 'rust/target/debug', process.platform === 'win32' ? 'pedelec-ipc-worker.exe' : 'pedelec-ipc-worker');

const providerSource = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
let turn = 0, threadId = 'thread-sdk', sdkThreadId = '', activeTurn = '', call = 0;
// The Agent's shell: the real pedelec-cli, found through the PATH and runtime file this process inherited.
const requestTool = () => {
  call += 1;
  const toolName = process.env.FAKE_TOOL_NAME || 'updateScript';
  const finishedTurn = activeTurn;
  // FAKE_TRACE: report the shell call as Codex App Server items, like a real commandExecution.
  const itemId = 'call-cli-' + call;
  const command = '/bin/zsh -lc "pedelec-cli --thread-id ' + sdkThreadId + ' tool-call ' + toolName + " '{}'" + '"';
  const trace = process.env.FAKE_TRACE === '1';
  if (trace) {
    send({ method: 'item/started', params: { threadId, turnId: finishedTurn, item: { id: 'call-ls', type: 'commandExecution', command: 'ls /missing', cwd: process.cwd(), status: 'inProgress' } } });
    send({ method: 'item/completed', params: { threadId, turnId: finishedTurn, item: { id: 'call-ls', type: 'commandExecution', command: 'ls /missing', cwd: process.cwd(), status: 'failed', exitCode: 1, aggregatedOutput: 'ls: /missing: No such file or directory' } } });
    send({ method: 'item/started', params: { threadId, turnId: finishedTurn, item: { id: itemId, type: 'commandExecution', command, cwd: process.cwd(), status: 'inProgress' } } });
  }
  execFile('pedelec-cli', ['--thread-id', sdkThreadId, 'tool-call', toolName, '{}'], (error, stdout) => {
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ cli: toolName, failed: !!error, stdout }) + '\\n');
    if (trace) send({ method: 'item/completed', params: { threadId, turnId: finishedTurn, item: { id: itemId, type: 'commandExecution', command, cwd: process.cwd(), status: error ? 'failed' : 'completed', exitCode: error ? 1 : 0, aggregatedOutput: stdout } } });
    if (error || !JSON.parse(stdout).ok) return;
    if (call < Number(process.env.FAKE_TOOL_COUNT || '1')) { requestTool(); return; }
    send({ method: 'turn/completed', params: { threadId, turn: { id: finishedTurn, status: 'completed', items: [] } } });
  });
};
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(process.env.FAKE_CODEX_LOG, line + '\\n');
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.method === 'initialize') send({ id: frame.id, result: { userAgent: 'fake', codexHome: 'h', platformFamily: 'unix', platformOs: 'unix' } });
  else if (frame.method === 'thread/start') {
    sdkThreadId = /--thread-id (\\S+)/.exec(frame.params.developerInstructions ?? '')?.[1] ?? '';
    send({ id: frame.id, result: { thread: { id: threadId } } });
  }
  else if (frame.method === 'turn/start') {
    turn += 1; activeTurn = 'provider-turn-' + turn;
    if (process.env.FAKE_HANG_SEND === '1') return;
    send({ id: frame.id, result: { turn: { id: activeTurn } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: activeTurn, status: 'inProgress' } } });
    if (process.env.FAKE_TOOL === '1') {
      call = 0;
      requestTool();
      return;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: activeTurn, itemId: 'm', delta: 'Hello ' } });
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId: activeTurn, itemId: 'm', delta: 'world' } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'completed', items: [{ id: 'm', type: 'agentMessage', text: 'Hello world' }] } } });
  } else if (frame.id !== undefined) send({ id: frame.id, result: {} });
});
`;

const updateScript = defineTool({ name: 'updateScript', description: 'Sync graph.', argsSchema: { type: 'object', properties: {}, required: [] } });
const cliReplies = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  .filter(frame => frame.cli).map(frame => JSON.parse(frame.stdout || '{}'));
const dirs: string[] = [];
const runtimes: PedelecNodeClient[] = [];

function fixture(env: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-node-sdk-')));
  dirs.push(dir);
  const module = join(dir, 'fake-codex.mjs');
  const windows = process.platform === 'win32';
  const executable = join(dir, windows ? 'fake-codex.cmd' : 'fake-codex.sh');
  const log = join(dir, 'codex.jsonl');
  writeFileSync(module, providerSource);
  if (windows) {
    writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${module}" %*\r\n`);
  } else {
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${module}'\n`, { mode: 0o755 });
  }
  const providerEnv = { ...process.env, PEDELEC_CODEX_PATH: executable, FAKE_CODEX_LOG: log, ACP_FIXTURE_LOG: join(dir, 'acp.jsonl'), ...env };
  if (windows) {
    // Windows cannot launch the POSIX shebangs in the fake Claude/ACP fixtures.
    // Wrap only explicitly provided test fixtures, preserving real-provider paths.
    for (const key of ['PEDELEC_CLAUDE_PATH', 'PEDELEC_OPENCODE_PATH', 'PEDELEC_CURSOR_PATH'] as const) {
      const target = providerEnv[key];
      if (!target || !target.includes('pedelec-ipc-worker') || !target.includes('fixtures')) continue;
      const wrapper = join(dir, `${key}.cmd`);
      const interpreter = target.endsWith('.py') ? 'python -X utf8' : `"${process.execPath}"`;
      writeFileSync(wrapper, `@echo off\r\n${interpreter} "${target}" %*\r\n`);
      providerEnv[key] = wrapper;
    }
  }
  return { dir, log, env: providerEnv };
}

async function runtimeFor(env: Record<string, string> = {}, sendTimeoutMs?: number, detailedMonitoring = false) {
  const fx = fixture(env);
  const sdk = await createPedelecRuntime({ rustIpc: { binaryPath: workerPath, cwd: fx.dir, env: fx.env }, sendTimeoutMs, detailedMonitoring });
  runtimes.push(sdk);
  return { sdk, ...fx };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

beforeAll(() => {
  if (!existsSync(workerPath)) {
    const built = spawnSync('cargo', ['build', '-p', 'pedelec-ipc-worker', '--manifest-path', 'rust/Cargo.toml'], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('RUST_WORKER_BUILD_FAILED');
  }
});

afterEach(async () => {
  for (const sdk of runtimes.splice(0)) await sdk.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SDK-02/06 on the real Rust IPC worker', () => {
  it('streams deltas, emits one complete chat message and stops the worker on close', async () => {
    const { sdk, dir } = await runtimeFor();
    const session = await sdk.createSession({
      provider: 'codex', model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
    });
    expect(session.providerSessionId).toBe('thread-sdk');
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const deltas: string[] = [], chats: string[] = [], outcomes: PedelecTurnOutcome[] = [];
    session.onChatDelta((text) => { deltas.push(text); });
    session.onChat((content) => { chats.push(content); });
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await expect(session.sendText('hi', { turnId: 'turn-1' })).resolves.toMatchObject({ accepted: true, turnId: 'turn-1' });
    await waitFor(() => outcomes.length === 1, 5_000);
    expect(deltas.join('')).toBe('Hello world');
    expect(chats).toEqual(['Hello world']);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', providerStatus: 'completed' });
    expect(session.getStatus()).toBe('idle');
    await session.close('test complete');
    expect(session.getStatus()).toBe('ended');
  });

  it('opens and runs a real Codex worker session with an empty dynamic Tool manifest', async () => {
    const { sdk, dir } = await runtimeFor();
    const session = await sdk.createSession({
      provider: 'codex',
      model: 'gpt-test', effort: 'default', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), hostInstructions: 'Host supplies policy.', tools: [],
    });
    expect(session.providerSessionId).toBe('thread-sdk');
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded(outcome => { outcomes.push(outcome); });
    await session.sendText('Tool-free.', { turnId: 'no-tools' });
    await waitFor(() => outcomes.length === 1, 5000);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [] });
    await sdk.close();
  });

  it('roundtrips an arbitrary new Host Tool without Rust recompilation', async () => {
    const { sdk, dir } = await runtimeFor({ FAKE_TOOL: '1', FAKE_TOOL_NAME: 'customEcho' });
    const tool = defineTool({ name: 'customEcho', description: 'Host-defined echo', argsSchema: { type: 'object' } });
    const session = await sdk.createSession({
      provider: 'codex',
      model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [tool],
    });
    const calls: string[] = [];
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTool('customEcho', (_args, ctx) => { calls.push(ctx.toolName); return { success: true, result: { echoed: true } }; });
    session.onTurnEnded(o => { outcomes.push(o); });
    await session.sendText('Call the custom tool.', { turnId: 'custom-turn' });
    await waitFor(() => outcomes.length === 1, 5_000);
    expect(calls).toEqual(['customEcho']);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [{ toolName: 'customEcho', state: 'acknowledged' }] });
    await sdk.close();
  });

  it.each(['throw', 'oversized'] as const)('C05: leaves a %s Host result unknown without replying or resending through the real worker', async mode => {
    const { sdk, dir, log } = await runtimeFor({ FAKE_TOOL: '1' });
    const session = await sdk.createSession({
      provider: 'codex',
      model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
    });
    let calls = 0;
    session.onTool('updateScript', () => {
      calls += 1;
      if (mode === 'throw') throw new Error('ambiguous Host effect');
      return { success: true, result: 'x'.repeat(70_000) };
    });
    await session.sendText('Call.', { turnId: 'failed-result' });
    await waitFor(() => session.getStatus() === 'outcome-unknown', 5000);
    await expect(session.sendText('Retry.')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await sdk.close();
    const frames = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toBe(1);
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(cliReplies(log).filter(reply => reply.ok === true)).toHaveLength(0);
  });

  it('C06: an actually received provider turn with a lost response times out without resend', async () => {
    const { sdk, dir, log } = await runtimeFor({ FAKE_HANG_SEND: '1' }, 1000);
    const session = await sdk.createSession({
      provider: 'codex',
      model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [],
    });
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded(o => { outcomes.push(o); });
    await expect(session.sendText('Received by provider.', { turnId: 'lost-send-response' }))
      .rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', transportCode: 'IPC_TIMEOUT' });
    expect(session.getStatus()).toBe('outcome-unknown');
    await expect(session.sendText('Retry.')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await sdk.close();
    const frames = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(1);
    expect(outcomes.some(o => o.terminal === 'completed')).toBe(false);
  });

  it('C03: acknowledges two sequential tool calls in one turn exactly once through the real worker', async () => {
    const { sdk, dir, log } = await runtimeFor({ FAKE_TOOL: '1', FAKE_TOOL_NAME: 'customEcho', FAKE_TOOL_COUNT: '2' });
    const tool = defineTool({ name: 'customEcho', description: 'Host echo', argsSchema: { type: 'object' } });
    const session = await sdk.createSession({
      provider: 'codex',
      model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [tool],
    });
    const calls: string[] = [], outcomes: PedelecTurnOutcome[] = [];
    session.onTool('customEcho', (_args, ctx) => {
      calls.push(ctx.toolCallId);
      return { success: true, result: { call: ctx.toolCallId } };
    });
    session.onTurnEnded(o => { outcomes.push(o); });
    await session.sendText('Call twice.', { turnId: 'two-calls' });
    await waitFor(() => outcomes.length === 1, 5000);
    expect(new Set(calls).size).toBe(2);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [
      { toolCallId: calls[0], state: 'acknowledged' },
      { toolCallId: calls[1], state: 'acknowledged' },
    ] });
    expect(cliReplies(log).map(reply => reply.result.call)).toEqual(calls);
    await sdk.close();
  });

  it('C11: isolates identical turn and tool call IDs across two real worker/provider processes', async () => {
    const fixtures = await Promise.all([runtimeFor({ FAKE_TOOL: '1' }), runtimeFor({ FAKE_TOOL: '1' })]);
    const calls: string[] = [], outcomes: PedelecTurnOutcome[] = [];
    const sessions = await Promise.all(fixtures.map(async ({ sdk, dir }, index) => {
      const session = await sdk.createSession({
        provider: 'codex',
        model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
      });
      session.onTool('updateScript', (_args, ctx) => {
        expect(ctx.sessionId).toBe(session.sessionId);
        expect(ctx.turnId).toBe('same-turn');
        calls.push(ctx.sessionId);
        return { success: true, result: { session: ctx.sessionId } };
      });
      session.onTurnEnded(o => { outcomes.push(o); });
      return session;
    }));
    await Promise.all(sessions.map(session => session.sendText('Call.', { turnId: 'same-turn' })));
    await waitFor(() => outcomes.length === 2, 5000);
    expect(calls.sort()).toEqual(sessions.map(s => s.sessionId).sort());
    expect(outcomes.every(o => o.terminal === 'completed')).toBe(true);
    for (const [index, fx] of fixtures.entries()) {
      expect(cliReplies(fx.log)).toEqual([{ ok: true, result: { session: sessions[index]!.sessionId } }]);
      await fx.sdk.close();
    }
  });

  it('round-trips one tool call through the worker and leaves no worker process after sdk.close', async () => {
    const { sdk, dir, log } = await runtimeFor({ FAKE_TOOL: '1' });
    const sessions = await Promise.all([1, 2].map(() => sdk.createSession({
      provider: 'codex', model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
    })));
    const handled: string[] = [];
    const outcomes: PedelecTurnOutcome[] = [];
    for (const session of sessions) {
      session.onTool('updateScript', (_args, context) => { handled.push(context.sessionId); return { success: true, result: { synced: true } }; });
      session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    }
    await sessions[0]!.sendText('sync');
    await waitFor(() => outcomes.length === 1, 5_000);
    expect(handled).toEqual([sessions[0]!.sessionId]);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [{ toolName: 'updateScript', state: 'acknowledged' }] });
    expect(sessions[1]!.getStatus()).toBe('idle');
    expect(cliReplies(log)).toEqual([{ ok: true, result: { synced: true } }]);

    const pids = (sdk as unknown as { sessions: Map<string, { connection: { pid?: number } }> }).sessions;
    const workerPids = [...pids.values()].map((entry) => entry.connection.pid).filter((pid): pid is number => typeof pid === 'number');
    expect(workerPids).toHaveLength(2);
    await sdk.close();
    await waitFor(() => workerPids.every((pid) => !alive(pid)), 5_000);
    expect(sessions.map((session) => session.getStatus())).toEqual(['ended', 'ended']);
  });
});

describe('TRACE-10 Level 1 Agent Tool Trace through the real Rust worker (fake Codex App Server, real pedelec-cli)', () => {
  it('reports native Shell items and the Host Tool as separate sources without detailed monitoring, before the Turn ends', async () => {
    const { sdk, dir, log } = await runtimeFor({ FAKE_TOOL: '1', FAKE_TRACE: '1' });
    const session = await sdk.createSession({
      provider: 'codex', model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
    });
    const events: AgentToolEvent[] = [];
    session.onAgentToolEvent((event) => { events.push(event); });
    session.onTool('updateScript', () => ({ success: true, result: { synced: true } }));
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('sync', { turnId: 'turn-trace' });
    await waitFor(() => outcomes.length === 1 && events.filter((e) => e.kind === 'finished').length === 3, 10_000);
    expect(outcomes[0]).toMatchObject({ terminal: 'completed', toolCalls: [{ toolName: 'updateScript', state: 'acknowledged' }] });
    expect(cliReplies(log)).toEqual([{ ok: true, result: { synced: true } }]);
    const ls = events.filter((e) => e.nativeToolCallId === 'call-ls');
    expect(ls.map((e) => [e.kind, e.status, e.exitCode])).toEqual([['started', 'running', undefined], ['finished', 'failed', 1]]);
    expect(ls[1]).toMatchObject({ provider: 'codex', toolName: 'commandExecution', toolKind: 'shell', coverage: 'supported', turnId: 'turn-trace' });
    // 01A: no redaction; the private workdir path is delivered verbatim.
    expect((ls[0]!.input as { cwd: string }).cwd).toBe(dir);
    const shell = events.filter((e) => e.nativeToolCallId === 'call-cli-1');
    expect(shell.map((e) => e.kind)).toEqual(['started', 'finished']);
    expect(shell[1]).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(shell[0]!.hostInvocations).toEqual([{ subcommand: 'tool-call', toolName: 'updateScript' }]);
    const host = events.filter((e) => e.source === 'pedelec-host');
    expect(host.filter((e) => e.kind === 'finished')).toHaveLength(1);
    // No trusted parent id exists in the pedelec-cli protocol: Host stays unlinked (no command-text guess).
    expect(host.find((e) => e.kind === 'finished')).toMatchObject({ toolName: 'updateScript', status: 'completed', correlation: 'unlinked' });
    expect(host.every((e) => e.parentToolCallId === undefined)).toBe(true);
    expect(shell[0]!.toolCallId).toBe(shell[1]!.toolCallId);
    expect(events.some((e) => e.status === 'unknown')).toBe(false);
    expect(events.some((e) => e.kind === 'observation-gap')).toBe(false);
  });

  it('declares tool-trace coverage in the real Worker receipt; an unreported shell leaves the Host call unlinked', async () => {
    const { sdk, dir } = await runtimeFor({ FAKE_TOOL: '1' });
    const session = await sdk.createSession({
      provider: 'codex', model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [updateScript],
    });
    const events: AgentToolEvent[] = [];
    session.onAgentToolEvent((event) => { events.push(event); });
    session.onTool('updateScript', () => ({ success: true, result: null }));
    const done: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { done.push(outcome); });
    await session.sendText('sync');
    await waitFor(() => done.length === 1 && events.some((e) => e.kind === 'finished'), 10_000);
    expect(events.some((e) => e.kind === 'observation-gap')).toBe(false);
    expect(events.find((e) => e.kind === 'finished')).toMatchObject({ source: 'pedelec-host', correlation: 'unlinked' });
  });
});

describe('TRACE-11 real Rust worker pumps for Claude and ACP providers (fake provider processes)', () => {
  it.each([
    ['claude', 'toolu_fixture', 'Bash', undefined],
    ['opencode', 'fixture-call', 'bash', 0],
    ['cursor', 'fixture-call', 'execute', undefined],
  ] as const)('%s native tool frames reach onAgentToolEvent before the Turn ends', async (provider, nativeId, toolName, exitCode) => {
    const fixtures = resolve('rust/crates/pedelec-ipc-worker/tests/fixtures');
    const { sdk, dir } = await runtimeFor({
      PEDELEC_CLAUDE_PATH: join(fixtures, 'fake_claude_cli.py'),
      PEDELEC_OPENCODE_PATH: join(fixtures, 'fake-acp.mjs'),
      PEDELEC_CURSOR_PATH: join(fixtures, 'fake-acp.mjs'),
      ACP_FIXTURE_PROVIDER: provider, ACP_FIXTURE_TRACE: '1', FAKE_CLAUDE_TRACE: '1',
    });
    const session = await sdk.createSession({ provider, model: provider === 'claude' ? 'sonnet' : 'test-model', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [] });
    const events: AgentToolEvent[] = [];
    let endedAt = -1;
    session.onAgentToolEvent((event) => { events.push(event); });
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { outcomes.push(outcome); endedAt = events.length; });
    await session.sendText('trace', { turnId: 'turn-trace' });
    await waitFor(() => outcomes.length === 1 && events.some((e) => e.kind === 'finished'), 8000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(outcomes[0]!.terminal).toBe('completed');
    const call = events.filter((e) => e.nativeToolCallId === nativeId);
    expect(call.map((e) => e.kind)).toEqual(['started', 'finished']);
    expect(call[1]).toMatchObject({ provider, toolName, toolKind: 'shell', status: 'completed', turnId: 'turn-trace', coverage: 'supported' });
    if (exitCode === undefined) { expect(call[1]).not.toHaveProperty('exitCode'); expect(call[1]!.unavailable).toContain('exitCode'); }
    else expect(call[1]!.exitCode).toBe(exitCode);
    // The real result was processed before the terminal; the SDK synthesises nothing.
    expect(events.some((e) => e.status === 'unknown')).toBe(false);
    expect(endedAt).toBeGreaterThanOrEqual(0);
    await session.close('done');
  });
});

describe('TRACE-12 fault injection: trace-only failures never stop the real Worker provider pump', () => {
  const fixtures = resolve('rust/crates/pedelec-ipc-worker/tests/fixtures');
  const providerEnv = {
    PEDELEC_CLAUDE_PATH: join(fixtures, 'fake_claude_cli.py'),
    PEDELEC_OPENCODE_PATH: join(fixtures, 'fake-acp.mjs'),
    PEDELEC_CURSOR_PATH: join(fixtures, 'fake-acp.mjs'),
    ACP_FIXTURE_TRACE: '1', FAKE_CLAUDE_TRACE: '1', FAKE_TOOL: '1', FAKE_TRACE: '1',
  };

  async function run(provider: 'codex' | 'claude' | 'opencode' | 'cursor', fault: string | undefined) {
    const { sdk, dir, log } = await runtimeFor({ ...providerEnv, ACP_FIXTURE_PROVIDER: provider, ...(fault ? { PEDELEC_TOOL_TRACE_FAULT: fault } : {}) });
    const tools = provider === 'codex' ? [updateScript] : [];
    const session = await sdk.createSession({ provider, model: provider === 'claude' ? 'sonnet' : 'test-model', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools });
    const events: AgentToolEvent[] = [];
    session.onAgentToolEvent((event) => { events.push(event); });
    if (provider === 'codex') session.onTool('updateScript', () => ({ success: true, result: { synced: true } }));
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded((outcome) => { outcomes.push(outcome); });
    await session.sendText('trace', { turnId: 'turn-fault' });
    await waitFor(() => outcomes.length === 1, 10_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const replies = provider === 'codex' ? cliReplies(log) : [];
    const status = session.getStatus();
    // The same Session keeps working: a second Turn completes too.
    await session.sendText('again', { turnId: 'turn-fault-2' });
    await waitFor(() => outcomes.length === 2, 10_000);
    await session.close('done');
    return {
      business: JSON.stringify([outcomes.map((o) => [o.terminal, o.toolCalls.map((c) => [c.toolName, c.state])]), replies, status]),
      events,
    };
  }

  it.each(['codex', 'claude', 'opencode', 'cursor'] as const)('%s: parse / emit / emit+gap faults keep Tool reply, ACK and Turn outcomes identical to the baseline', async (provider) => {
    const baseline = await run(provider, undefined);
    expect(baseline.events.some((e) => e.source === 'provider-native' && e.kind === 'finished')).toBe(true);
    expect(JSON.parse(baseline.business)[0][0][0]).toBe('completed');

    const parse = await run(provider, 'parse');
    expect(parse.business).toBe(baseline.business);
    expect(parse.events.filter((e) => e.source === 'provider-native' && e.kind !== 'observation-gap')).toEqual([]);
    expect(parse.events.some((e) => e.kind === 'observation-gap' && e.errorCode === 'TRACE_PARSE_FAILED')).toBe(true);

    const emit = await run(provider, 'emit');
    expect(emit.business).toBe(baseline.business);
    expect(emit.events.filter((e) => e.source === 'provider-native' && e.kind !== 'observation-gap')).toEqual([]);
    // Losses are reported by the next deliverable gap.
    expect(emit.events.find((e) => e.errorCode === 'TRACE_EMIT_FAILED')).toMatchObject({ coverage: 'partial', output: { droppedObservations: expect.any(Number) } });

    const both = await run(provider, 'emit,gap');
    expect(both.business).toBe(baseline.business);
    expect(both.events.filter((e) => e.source === 'provider-native')).toEqual([]);
    // Host Trace is an SDK path and is unaffected by Worker trace faults.
    if (provider === 'codex') expect(both.events.filter((e) => e.source === 'pedelec-host' && e.kind === 'finished')).toHaveLength(2);
  }, 60_000);
});

describe('Desktop detailed monitor through the real Rust worker', () => {
  it('shows callback delivery, provider RPC, semantic frames, and IPC payloads together', async () => {
    const { sdk, dir } = await runtimeFor({}, undefined, true);
    const events: PedelecMonitorEvent[] = [];
    sdk.onMonitorEvent((event) => { events.push(event); });
    const session = await sdk.createSession({ provider: 'codex', model: 'gpt-test', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [] });
    session.onChat(() => undefined);
    await session.sendText('A visible trace request', { turnId: 'trace-turn' });
    await waitFor(() => session.getStatus() === 'idle', 5_000);
    expect(events.find((event) => event.kind === 'sdk.onChat')).toMatchObject({ data: { text: 'Hello world' } });
    expect(events.find((event) => event.kind === 'transport.event'
      && (event.data as any).data?.type === 'assistant-message')).toMatchObject({
      data: { kind: 'turn', data: { text: 'Hello world' } },
    });
    expect(events.find((event) => event.kind === 'provider.rpc'
      && (event.data as any).payload?.method === 'turn/start')).toBeDefined();
    expect(events.find((event) => event.kind === 'transport.request'
      && (event.data as any).op === 'send')).toMatchObject({
      data: { frame: { payload: { text: 'A visible trace request' } } },
    });
    await session.close('done');
  });
});

describe('P06 production routing with real SDK and fake providers', () => {
  it.each(['claude', 'opencode', 'cursor'])('%s opens a tool-free session, emits metadata and closes', async (provider) => {
    const fixtures = resolve('rust/crates/pedelec-ipc-worker/tests/fixtures');
    const { sdk, dir } = await runtimeFor({
      PEDELEC_CLAUDE_PATH: join(fixtures, 'fake_claude_cli.py'),
      PEDELEC_OPENCODE_PATH: join(fixtures, 'fake-acp.mjs'),
      PEDELEC_CURSOR_PATH: join(fixtures, 'fake-acp.mjs'),
      ACP_FIXTURE_PROVIDER: provider,
    });
    const events: unknown[] = [];
    sdk.onMonitorEvent(event => { events.push(event); });
    const session = await sdk.createSession({ provider, model: provider === 'claude' ? 'sonnet' : 'test-model', effort: 'high', workdir: dir, runtimeStorageRoot: join(dir, 'runtime'), tools: [] });
    expect(session.capabilities).toMatchObject({ runtimeOpen: true, sendTurn: true, hostTools: true,
      cancelTurn: 'native' });
    const outcomes: PedelecTurnOutcome[] = [];
    session.onTurnEnded(outcome => { outcomes.push(outcome); });
    await session.sendText('PRIVATE-PROMPT-SENTINEL', { turnId: 'tool-free' });
    await waitFor(() => outcomes.length === 1, 5000);
    expect(outcomes[0]!.terminal).toBe('completed');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'session.opened', data: expect.objectContaining({ provider }) })]));
    expect(JSON.stringify(events)).not.toContain('PRIVATE-PROMPT-SENTINEL');
    await session.close('done');
  });
});
