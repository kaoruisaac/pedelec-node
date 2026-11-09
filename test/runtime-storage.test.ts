import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createPedelecRuntime, type PedelecNodeClient } from '../src/index.ts';
import { defaultWorkerPath, RustIpcSupervisor } from '../src/transport/rust-ipc-supervisor.mjs';
import { sessionStorage } from '../src/runtime-storage.ts';
import { fakeTransport, waitFor } from './fake-transport.ts';

const dirs: string[] = [];
const clients: PedelecNodeClient[] = [];

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-storage-')));
  dirs.push(dir);
  const workdir = join(dir, 'work');
  mkdirSync(workdir);
  const input = { provider: 'ollama', model: 'fake', effort: 'default', tools: [], workdir, runtimeStorageRoot: join(dir, 'runtime') };
  return { dir, input };
}

async function client(transport = fakeTransport()) {
  const sdk = await createPedelecRuntime({ transport });
  clients.push(sdk);
  return sdk;
}

afterEach(async () => {
  for (const sdk of clients.splice(0)) await sdk.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('A1/B4 binds two roots in one runtime and sweeps each only on its next use', async () => {
  const { dir, input } = fixture();
  const other = { ...input, runtimeStorageRoot: join(dir, 'separate-root'), provider: 'codex' };
  const legacy = join(input.runtimeStorageRoot, 'artifacts', 'old-task');
  const unowned = join(input.runtimeStorageRoot, 'instances', randomUUID());
  for (const path of [legacy, unowned]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep'), 'precious');
  }
  const sdk = await client();
  const a = await sdk.createSession(input);
  const b = await sdk.createSession(other);
  expect(a.artifactDirectory.startsWith(input.runtimeStorageRoot)).toBe(true);
  expect(b.artifactDirectory.startsWith(other.runtimeStorageRoot)).toBe(true);
  expect(b.providerStateDirectory).toBeUndefined();
  expect(() => Object.assign(a, { artifactDirectory: dir })).toThrow();
  expect(existsSync(join(input.workdir, '.pedelec-runtime'))).toBe(false);
  await a.close('ended');
  await b.dispose();
  await sdk.close();
  expect(existsSync(a.artifactDirectory)).toBe(true);
  expect(existsSync(b.artifactDirectory)).toBe(true);

  const next = await client();
  await expect(next.resumeSession(a.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
  const current = await next.createSession({ ...input, sessionId: a.sessionId });
  expect(existsSync(a.artifactDirectory)).toBe(false);
  expect(existsSync(a.providerStateDirectory!)).toBe(false);
  expect(existsSync(current.artifactDirectory)).toBe(true);
  expect(existsSync(b.artifactDirectory)).toBe(true);
  await next.createSession(other);
  expect(existsSync(b.artifactDirectory)).toBe(false);
  await next.close();

  const third = await client();
  await third.createSession(input);
  expect(existsSync(current.artifactDirectory)).toBe(false);
  for (const path of [legacy, unowned]) expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('precious');
});

it('B1/B2 collects only the oldest confirmed ended Session across roots and preserves replacement data', async () => {
  const { dir, input } = fixture();
  const sdk = await client();
  const oldest = await sdk.createSession(input);
  const artifact = join(oldest.artifactDirectory, 'landed');
  const store = join(oldest.providerStateDirectory!, 'store');
  writeFileSync(artifact, 'image');
  writeFileSync(store, 'transcript');
  await oldest.close('ended');
  const replacement = sdk.replaceEndedSession(oldest.sessionId);
  expect(readFileSync(artifact, 'utf8')).toBe('image');
  expect(readFileSync(store, 'utf8')).toBe('transcript');
  const others = [];
  for (let i = 0; i < 50; i++) {
    const session = await sdk.createSession({ ...input, runtimeStorageRoot: join(dir, 'other') });
    others.push(session);
    await session.close('ended');
  }
  await expect(replacement.resume()).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
  expect(existsSync(oldest.artifactDirectory)).toBe(false);
  expect(existsSync(oldest.providerStateDirectory!)).toBe(false);
  expect(sdk.listSessions()).toEqual(others);
  expect(others.every((session) => existsSync(session.artifactDirectory) && existsSync(session.providerStateDirectory!))).toBe(true);
});

it('B3 keeps an unconfirmed Turn on disk without replay and sweeps it at the next start', async () => {
  const { input } = fixture();
  const transport = fakeTransport();
  const sdk = await client(transport);
  const session = await sdk.createSession(input);
  const artifact = join(session.artifactDirectory, 'landed');
  const state = join(session.providerStateDirectory!, 'store');
  writeFileSync(artifact, 'image');
  writeFileSync(state, 'transcript');
  await session.sendText('effect', { turnId: 'ambiguous' });
  transport.connections[0]!.emit('crash', {});
  await waitFor(() => session.getStatus() === 'outcome-unknown');
  await expect(session.sendText('effect again')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  expect(transport.connections[0]!.count('send')).toBe(1);
  expect(readFileSync(artifact, 'utf8')).toBe('image');
  expect(readFileSync(state, 'utf8')).toBe('transcript');
  await sdk.close();
  expect(existsSync(artifact)).toBe(true);
  await (await client()).createSession(input);
  expect(existsSync(artifact)).toBe(false);
  expect(existsSync(state)).toBe(false);
});

it('B4 refuses a live owner in another process and sweeps after the owner is killed', async () => {
  const { input } = fixture();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/storage-owner.ts', import.meta.url)), input.runtimeStorageRoot, input.workdir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(child, 'close');
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const line = await lines.next();
    expect(line.done).toBe(false);
    const old = JSON.parse(line.value) as { artifactDirectory: string; providerStateDirectory: string };
    const next = await client();
    await expect(next.createSession(input)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
    expect(readFileSync(join(old.artifactDirectory, 'landed.png'), 'utf8')).toBe('image');
    child.kill('SIGKILL');
    await exited;

    let started = false;
    const deadline = Date.now() + 5_000;
    while (!started && Date.now() < deadline) {
      // EOF releases the child keeper asynchronously, even after the owning Node process has exited.
      try { await next.createSession(input); started = true; }
      catch (error) {
        expect(error).toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    expect(started).toBe(true);
    expect(existsSync(old.artifactDirectory)).toBe(false);
    expect(existsSync(old.providerStateDirectory)).toBe(false);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

it('B5 refuses restart GC while a real Worker still holds a writer lease after the keeper dies', async () => {
  const { input } = fixture();
  const instance = randomUUID();
  const paths = sessionStorage(input.runtimeStorageRoot, instance, 'writer', 'ollama');
  const binaryPath = defaultWorkerPath();
  const keeper = spawn(binaryPath, ['--storage-keeper', input.runtimeStorageRoot, instance], { stdio: ['pipe', 'pipe', 'inherit'] });
  const keeperExited = once(keeper, 'close');
  const lines = createInterface({ input: keeper.stdout })[Symbol.asyncIterator]();
  let worker: RustIpcSupervisor | undefined;
  try {
    expect((await lines.next()).value).toBe('ok');
    keeper.stdin.write(JSON.stringify({ action: 'prepare', session: 'writer', ollama: true }) + '\n');
    expect((await lines.next()).value).toBe('ok');
    worker = await RustIpcSupervisor.start({ binaryPath, env: { ...process.env, ...paths.env } });
    writeFileSync(join(paths.artifactDirectory, 'landed'), 'keep');
    keeper.kill('SIGKILL');
    await keeperExited;
    const next = await client();
    await expect(next.createSession(input)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
    await expect(next.prepareStorageRootDeletion(input.runtimeStorageRoot)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
    expect(readFileSync(join(paths.artifactDirectory, 'landed'), 'utf8')).toBe('keep');
    await worker.shutdown();
    await next.createSession(input);
    expect(existsSync(paths.artifactDirectory)).toBe(false);
  } finally {
    keeper.kill('SIGKILL');
    await keeperExited;
    await worker?.shutdown();
  }
});

it('B5 leaves an incomplete sweep retryable and refuses a replaced lock inode', async () => {
  const { dir, input } = fixture();
  const sdk = await client();
  const session = await sdk.createSession(input);
  await sdk.close();
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'keep');
  const artifacts = dirname(session.artifactDirectory);
  renameSync(artifacts, join(dir, 'moved-artifacts'));
  symlinkSync(outside, artifacts, 'junction');
  const next = await client();
  const current = await next.createSession(input);
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep');
  expect(existsSync(session.providerStateDirectory!)).toBe(true);
  await next.close();
  rmSync(artifacts);
  renameSync(join(dir, 'moved-artifacts'), artifacts);

  const third = await client();
  await third.createSession(input);
  expect(existsSync(session.artifactDirectory)).toBe(false);
  expect(existsSync(current.artifactDirectory)).toBe(false);
  const lock = join(input.runtimeStorageRoot, '.owner.lock');
  renameSync(lock, join(dir, 'original-lock'));
  writeFileSync(lock, '');
  await expect(third.createSession(input)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
  await expect((await client()).createSession(input)).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE' });
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep');
});

it('B5 refuses FIFO cleanup of a Session directory that reappeared with a different identity', async () => {
  const { dir, input } = fixture();
  const sdk = await client();
  const session = await sdk.createSession(input);
  await session.close('ended');
  const moved = join(dir, 'original');
  renameSync(session.artifactDirectory, moved);
  mkdirSync(session.artifactDirectory);
  const replacement = join(session.artifactDirectory, 'replacement');
  writeFileSync(replacement, 'keep');
  for (let i = 0; i < 50; i++) await (await sdk.createSession(input)).close('ended');
  expect(sdk.getSession(session.sessionId)).toBeUndefined();
  expect(readFileSync(replacement, 'utf8')).toBe('keep');
  expect(existsSync(session.providerStateDirectory!)).toBe(true);
});

it.skipIf(process.platform !== 'win32')('B5 retries an instance whose artifact was locked by a Windows process', async () => {
  const { input } = fixture();
  const sdk = await client();
  const old = await sdk.createSession(input);
  const artifact = join(old.artifactDirectory, 'locked');
  writeFileSync(artifact, 'keep');
  await sdk.close();
  const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$f = [IO.File]::Open($env:PEDELEC_TEST_LOCK_FILE, "Open", "Read", "None"); [Console]::WriteLine("ready"); [Console]::ReadLine() > $null; $f.Dispose()',
  ], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PEDELEC_TEST_LOCK_FILE: artifact } });
  const exit = once(locker, 'close');
  try {
    const lines = createInterface({ input: locker.stdout })[Symbol.asyncIterator]();
    expect((await lines.next()).value).toBe('ready');
    const next = await client();
    await next.createSession(input);
    expect(existsSync(artifact)).toBe(true);
    await next.close();
  } finally {
    locker.stdin.end('\n');
    await exit;
  }
  await (await client()).createSession(input);
  expect(existsSync(old.artifactDirectory)).toBe(false);
});
