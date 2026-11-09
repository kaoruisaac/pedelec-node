import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { CliEndpoint } from '../src/transport/cli-endpoint.ts';
import { PedelecNodeSession } from '../src/session.ts';
import { defineTool } from '../src/tools.ts';
import { fakeTransport, waitFor } from './fake-transport.ts';

const exec = promisify(execFile);
const binary = resolve('rust/target/debug', process.platform === 'win32' ? 'pedelec-cli.exe' : 'pedelec-cli');
const tools = [defineTool({ name: 'echo', description: 'Echo value', argsSchema: {
  type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
} }), defineTool({ name: 'second', description: 'Second', argsSchema: { type: 'object', properties: {}, additionalProperties: false } })];
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });
async function setup(id = 's1', timeout = 500, descriptors = tools) {
  const endpoint = await CliEndpoint.start(id, descriptors);
  const fixture = fakeTransport();
  await fixture.connect();
  const connection = fixture.connections[0]!; // turn-control fixture only; tool transport is real TCP + Rust process
  const temporary = resolve(endpoint.runtimeFile, '..');
  const session = new PedelecNodeSession({
    sessionId: id, providerSessionId: 'provider', provider: 'codex', workdir: temporary,
    runtimeStorageRoot: resolve(temporary, 'runtime'), artifactDirectory: resolve(temporary, 'artifacts'), hostInstructions: '',
    model: 'fixture', effort: 'default', tools: descriptors, connection,
    cliEndpoint: endpoint, cliOnly: true, sendTimeoutMs: 500, toolReplyTimeoutMs: timeout, onDisposed: () => {}, observe: () => {} });
  cleanup.push(() => session.dispose());
  const cli = async (command: string, name = 'echo', args?: string, threadId = id) => {
    const { stdout } = await exec(binary, ['--thread-id', threadId, command, name, ...(args === undefined ? [] : [args])],
      { env: { ...process.env, PEDELEC_CORE_IPC_RUNTIME_FILE: endpoint.runtimeFile }, timeout: 5000 });
    return JSON.parse(stdout);
  };
  const raw = async (requestId: string, args: unknown = { value: 'x' }, extra: Record<string, unknown> = {}) => {
    const runtime = JSON.parse(await readFile(endpoint.runtimeFile, 'utf8'));
    return new Promise<any>((resolveReply, reject) => {
      const socket = createConnection({ host: runtime.host, port: runtime.port });
      let bytes = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => { bytes += chunk; if (bytes.includes('\n')) resolveReply(JSON.parse(bytes)); });
      socket.on('connect', () => socket.write(JSON.stringify({ requestId, type: 'tool_call',
        generation: runtime.generation, payload: { threadId: id, toolName: 'echo', args }, ...extra }) + '\n'));
    });
  };
  return { endpoint, session, connection, cli, raw };
}

describe('real Rust CLI → private Core IPC → Node SDK onTool (provider control fixture)', () => {
  it('spec has no effects, matches snapshots; real CLI stdout carries sequential handler results/failures', async () => {
    const { endpoint, session, cli, connection } = await setup();
    let effects = 0;
    session.onTool('echo', (args, context) => { context.assertActive(); effects++; return { success: true, result: args as any }; });
    session.onTool('second', () => ({ success: false, result: { why: 'denied' } }));
    expect((await stat(endpoint.runtimeFile)).isFile()).toBe(true);
    expect((await stat(resolve(endpoint.runtimeFile, '..'))).isDirectory()).toBe(true);
    // Runtime discovery is not an OS credential; the endpoint never emits a Session Token.
    expect(JSON.parse(await readFile(endpoint.runtimeFile, 'utf8'))).not.toHaveProperty('token');
    for (const tool of tools) expect((await cli('tool-spec', tool.name)).result).toMatchObject(tool);
    expect(effects).toBe(0);
    expect((await cli('tool-call', 'echo', '{"value":"x"}')).error.code).toBe('SESSION_NOT_ACTIVE');
    await session.sendText('go');
    expect(await cli('tool-call', 'echo', '{"value":"x"}')).toMatchObject({ ok: true, result: { value: 'x' } });
    expect(await cli('tool-call', 'second', '{}')).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED' }, result: { why: 'denied' } });
    expect(effects).toBe(1);
    expect(connection.count('toolReply')).toBe(0);
  });
  it('rejects foreign sessions, invalid schemas/names/JSON, legacy tokens and custom turn IDs without effects', async () => {
    const a = await setup('one'), b = await setup('two');
    let effects = 0;
    for (const x of [a, b]) {
      x.session.onTool('echo', () => { effects++; return { success: true, result: null }; });
      x.session.onTool('second', () => ({ success: true, result: null }));
      await x.session.sendText('go');
    }
    expect((await a.cli('tool-call', 'echo', '{"value":"x"}', 'two')).error.code).toBe('THREAD_ACCESS_DENIED');
    for (const args of ['{}', '{"value":1}', '{"value":"x","extra":1}', 'null']) {
      expect(await a.cli('tool-call', 'echo', args)).toMatchObject({ ok: false, error: {
        code: 'TOOL_SCHEMA_INVALID', message: expect.stringContaining('tool-spec argsSchema'),
      } });
    }
    expect(await a.cli('tool-call', 'echo', '{')).toMatchObject({ ok: false, error: { code: 'TOOL_JSON_INVALID' } });
    expect((await a.cli('tool-spec', 'missing')).error.code).toBe('TOOL_NOT_FOUND');
    expect((await a.raw('legacy-token', {}, { token: '0'.repeat(64) })).error.code).toBe('INVALID_INPUT');
    expect((await a.raw('turn-injection', {}, { turnId: 'custom' })).error.code).toBe('INVALID_INPUT');
    expect(effects).toBe(0);
  });
  it('replays identical IDs once; rejects changed arguments and concurrent pending; failure never retries', async () => {
    const { session, raw, cli } = await setup();
    let effects = 0, release!: () => void;
    session.onTool('echo', async () => { effects++; await new Promise<void>((r) => { release = r; }); return { success: false, result: 'failed effect' }; });
    session.onTool('second', () => ({ success: true, result: null }));
    await session.sendText('go');
    const first = raw('same-id');
    await waitFor(() => effects === 1);
    const replay = raw('same-id');
    expect((await raw('same-id', { value: 'changed' })).error.code).toBe('REQUEST_ID_CONFLICT');
    expect((await raw('other-id')).error.code).toBe('TOOL_PENDING');
    release();
    expect(await first).toEqual(await replay);
    expect((await raw('same-id')).ok).toBe(false);
    expect(effects).toBe(1);
    // New CLI processes get new request IDs; transport failures are never automatically retried.
    expect((await cli('tool-call', 'echo', '{"value":1}')).ok).toBe(false);
    expect(effects).toBe(1);
  });
  it('cancel aborts context, closes stale endpoint, refuses late success and new sends', async () => {
    const { endpoint, session, cli } = await setup();
    let context: any, release!: () => void, effects = 0;
    session.onTool('echo', async (_, c) => { context = c; effects++; await new Promise<void>((r) => { release = r; }); return { success: true, result: 'late' }; });
    session.onTool('second', () => ({ success: true, result: null }));
    await session.sendText('go');
    const result = cli('tool-call', 'echo', '{"value":"x"}');
    await waitFor(() => effects === 1);
    await session.cancel('cancel test');
    expect(context.signal.aborted).toBe(true);
    expect(() => context.assertActive()).toThrow();
    release();
    expect((await result).ok).toBe(false);
    await expect(readFile(endpoint.runtimeFile)).rejects.toThrow();
    await expect(session.sendText('again')).rejects.toThrow();
    expect(effects).toBe(1);
  });
  it('handler timeout/crash never returns success or dispatches a second effect', async () => {
    const { session, cli, connection } = await setup('timeout', 30);
    let effects = 0;
    session.onTool('echo', () => { effects++; return new Promise(() => {}); });
    session.onTool('second', () => ({ success: true, result: null }));
    await session.sendText('go');
    expect((await cli('tool-call', 'echo', '{"value":"x"}')).ok).toBe(false);
    expect(session.getStatus()).toBe('outcome-unknown');
    connection.emit('crash', {});
    expect(effects).toBe(1);
  });
  it('spec snapshots never leak another Session tool; turn generations and request IDs cannot replay in later turns', async () => {
    const a = await setup('one');
    const b = await setup('two', 500, [defineTool({ name: 'privateB', description: 'Only B', argsSchema: { type: 'object', properties: {} } })]);
    expect((await a.cli('tool-spec', 'privateB')).error.code).toBe('TOOL_NOT_FOUND');
    expect((await b.cli('tool-spec', 'privateB')).ok).toBe(true);
    let effects = 0;
    a.session.onTool('echo', () => { effects++; return { success: true, result: null }; });
    a.session.onTool('second', () => ({ success: true, result: null }));
    await a.session.sendText('turn one', { turnId: 'one' });
    const old = JSON.parse(await readFile(a.endpoint.runtimeFile, 'utf8'));
    expect((await a.raw('same')).ok).toBe(true);
    // Fixture provides terminal control only; the request/result still crosses the real endpoint.
    a.connection.sessionId = a.session.sessionId;
    a.connection.push('terminal', { status: 'completed' });
    await waitFor(() => a.session.getStatus() === 'idle');
    await a.session.sendText('turn two', { turnId: 'two' });
    expect((await a.raw('old-generation', { value: 'x' }, { generation: old.generation })).error.code).toBe('STALE_TURN');
    expect((await a.raw('same')).error.code).toBe('REQUEST_ID_CONFLICT');
    expect(effects).toBe(1);
  });
  it('close and worker crash cancel pending contexts, invalidate runtime discovery, and cannot report late success', async () => {
    for (const cause of ['close', 'crash']) {
      const x = await setup(cause);
      let ctx: any, finish!: () => void, effects = 0;
      x.session.onTool('echo', async (_, context) => { ctx = context; effects++; await new Promise<void>((r) => { finish = r; }); return { success: true, result: 'late' }; });
      x.session.onTool('second', () => ({ success: true, result: null }));
      await x.session.sendText('go');
      const result = x.cli('tool-call', 'echo', '{"value":"x"}');
      await waitFor(() => effects === 1);
      if (cause === 'close') await x.session.close('test close');
      else x.connection.emit('crash', {});
      expect(ctx.signal.aborted).toBe(true);
      expect(() => ctx.assertActive()).toThrow();
      finish();
      expect((await result).ok).toBe(false);
      expect(effects).toBe(1);
    }
  });
  it('a killed CLI aborts the pending handler and leaves the turn unknown without retry', async () => {
    const { endpoint, session } = await setup('killed-cli');
    let ctx: any, release!: () => void, effects = 0;
    session.onTool('echo', async (_, context) => { ctx = context; effects++; await new Promise<void>((r) => { release = r; }); return { success: true, result: 'late' }; });
    session.onTool('second', () => ({ success: true, result: null }));
    await session.sendText('go');
    const child = spawn(binary, ['--thread-id', session.sessionId, 'tool-call', 'echo', '{"value":"x"}'],
      { env: { ...process.env, PEDELEC_CORE_IPC_RUNTIME_FILE: endpoint.runtimeFile }, stdio: 'ignore' });
    try {
      await waitFor(() => effects === 1);
      child.kill('SIGKILL');
      await waitFor(() => ctx.signal.aborted);
      expect(session.getStatus()).toBe('outcome-unknown');
      expect(() => ctx.assertActive()).toThrow();
      release();
      expect(effects).toBe(1);
    } finally { child.kill('SIGKILL'); }
  });
  it('CLI missing/expired runtime and input errors print structured failure', async () => {
    for (const args of [[], ['--thread-id', 's', 'unknown', 'echo'], ['--thread-id', 's', 'tool-call', 'echo']]) {
      expect(JSON.parse((await exec(binary, args, { env: {} })).stdout).ok).toBe(false);
    }
    expect(JSON.parse((await exec(binary, ['--thread-id', 's', 'tool-spec', 'echo'], { env: {} })).stdout).error.code).toBe('CORE_RUNTIME_UNAVAILABLE');
    const { endpoint, cli } = await setup();
    await endpoint.close();
    expect((await cli('tool-spec')).ok).toBe(false);
  });
});
