import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPedelecRuntime, type PedelecNodeClient, type PedelecNodeSession } from '../src/index.ts';
import { RustIpcSupervisor } from '../src/transport/rust-ipc-supervisor.mjs';
import { randomUUID } from 'node:crypto';
import { waitFor } from './fake-transport.ts';

// Real Worker + real `pedelec-agent` + a fake Ollama HTTP server: the Provider Store is written by the real Provider.
const debugDir = resolve(process.cwd(), 'rust/target/debug');
const executable = (name: string) => join(debugDir, process.platform === 'win32' ? `${name}.exe` : name);
const workerPath = executable('pedelec-ipc-worker');

const dirs: string[] = [];
const runtimes: PedelecNodeClient[] = [];
const servers: Server[] = [];

async function fakeOllama(): Promise<string> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      if (request.url === '/api/show') { response.end(JSON.stringify({ capabilities: ['tools'] })); return; }
      const turns = (JSON.parse(body) as { messages: Array<{ role: string }> }).messages.filter((message) => message.role === 'user').length;
      response.setHeader('content-type', 'application/x-ndjson');
      response.end(`${JSON.stringify({ message: { role: 'assistant', content: `reply ${turns}` }, done: false })}\n${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('NO_ADDRESS');
  return `http://127.0.0.1:${address.port}`;
}

async function scene() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-ollama-store-')));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PEDELEC_OLLAMA_BASE_URL: await fakeOllama() };
  const sdk = await createPedelecRuntime({ rustIpc: { binaryPath: workerPath, cwd: root, env } });
  runtimes.push(sdk);
  const place = (taskId: string) => {
    const workdir = join(root, taskId);
    mkdirSync(workdir);
    return { workdir, runtimeStorageRoot: join(root, '.runtime') };
  };
  return { sdk, root, home, place, env };
}

const open = (sdk: PedelecNodeClient, paths: { workdir: string; runtimeStorageRoot: string }) => sdk.createSession({ provider: 'ollama', model: 'fake', effort: 'default', tools: [], ...paths });

async function turn(session: PedelecNodeSession, text: string, turnId: string): Promise<void> {
  let ended = false;
  const stop = session.onTurnEnded(() => { ended = true; });
  await session.sendText(text, { turnId });
  await waitFor(() => ended, 15_000);
  stop();
}

/** Every `session.json` under a Task root, with the transcript beside it: the store's own layout, read as it stands. */
function stores(root: string): Array<{ id: string; dir: string; transcript: string }> {
  const sessions = join(root, 'sessions');
  if (!existsSync(sessions)) return [];
  const found: Array<{ id: string; dir: string; transcript: string }> = [];
  for (const year of readdirSync(sessions)) for (const month of readdirSync(join(sessions, year))) for (const id of readdirSync(join(sessions, year, month))) {
    const dir = join(sessions, year, month, id);
    expect(year).toMatch(/^\d{4}$/);
    expect(month).toMatch(/^\d{2}$/);
    expect(readdirSync(dir).sort()).toEqual(['session.json', 'transcript.jsonl']);
    found.push({ id, dir, transcript: readFileSync(join(dir, 'transcript.jsonl'), 'utf8') });
  }
  return found;
}

const available = existsSync(executable('pedelec-agent'));

beforeAll(() => {
  if (available) return;
  const built = spawnSync('cargo', ['build', '-p', 'pedelec-ipc-worker', '-p', 'pedelec-agent', '-p', 'pedelec-cli', '--manifest-path', 'rust/Cargo.toml'], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('RUST_WORKER_BUILD_FAILED');
});

afterEach(async () => {
  for (const sdk of runtimes.splice(0)) await sdk.close();
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MD25 A2 Ollama Provider Store on the real Worker and Agent', () => {
  it('persists one private store per Session, including Sessions sharing a workdir', async () => {
    const { sdk, home, place } = await scene();
    const first = place('task-a');
    const second = place('task-b');
    const a1 = await open(sdk, first);
    const a2 = await open(sdk, first);
    const b1 = await open(sdk, second);

    await turn(a1, 'first of a', 'a-1');
    await turn(a2, 'second of a', 'a-2');
    await turn(b1, 'only of b', 'b-1');

    const [firstStore, secondStore, otherStore] = [a1, a2, b1].map((session) => {
      const store = stores(session.providerStateDirectory!);
      expect(store.map(({ id }) => id)).toEqual([session.providerSessionId]);
      return store[0]!.transcript;
    });
    expect(firstStore).toContain('first of a');
    expect(firstStore).not.toContain('second of a');
    expect(secondStore).toContain('second of a');
    expect(otherStore).toContain('only of b');
    expect(otherStore).not.toContain('of a');
    expect(existsSync(join(home, '.pedelec'))).toBe(false);
    expect(readdirSync(first.workdir)).toEqual([]);
  });

  it('resumes an ended Session of the same Runtime from its own store', async () => {
    const { sdk, place } = await scene();
    const paths = place('task-a');
    const session = await open(sdk, paths);
    await turn(session, 'before the end', 'turn-1');
    const [{ dir }] = stores(session.providerStateDirectory!) as [{ dir: string }];
    await session.close('done');
    await waitFor(() => session.isWorkerStopped(), 10_000);

    const resumed = await sdk.resumeSession(session.sessionId);
    await resumed.resume();
    await turn(resumed, 'after the resume', 'turn-2');

    expect(resumed.providerSessionId).toBe(session.providerSessionId);
    expect(stores(session.providerStateDirectory!)).toHaveLength(1);
    const transcript = readFileSync(join(dir, 'transcript.jsonl'), 'utf8');
    expect(transcript).toContain('before the end');
    expect(transcript).toContain('after the resume');
  });

  it('refuses to open without a store instead of falling back to Home', async () => {
    const { sdk, home, place, env } = await scene();
    const { workdir } = place('task-a');
    await expect(open(sdk, { workdir } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const worker = await RustIpcSupervisor.start({ binaryPath: workerPath, env });
    try {
      await expect(worker.openSession({
        requestId: randomUUID(), sessionId: 'no-store', provider: 'ollama', model: 'fake',
        effort: 'default', serverWorkdir: workdir, tools: [], hostInstructions: '',
      })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally { await worker.shutdown(); }
    expect(existsSync(join(home, '.pedelec'))).toBe(false);
    expect(readdirSync(workdir)).toEqual([]);
  });
});
