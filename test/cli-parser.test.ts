import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const binary = resolve('rust/target/debug/pedelec-cli');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function cli(args: string[], runtime?: string) {
  const { stdout, stderr } = await exec(binary, args, { env: runtime ? { PEDELEC_CORE_IPC_RUNTIME_FILE: runtime } : {} });
  expect(stderr).toBe('');
  return JSON.parse(stdout);
}
it('real executable prints structured parser and missing-runtime errors', async () => {
  for (const tail of [[], ['tool-call', 'echo'], ['unknown', 'echo'], ['tool-spec', '../bad']]) {
    expect(await cli(['--thread-id', 's', ...tail])).toMatchObject({ ok: false, error: { code: 'TOOL_ARGS_INVALID' } });
  }
  expect(await cli(['--thread-id', 's', 'tool-call', 'echo', '{'])).toMatchObject({ ok: false, error: {
    code: 'TOOL_JSON_INVALID', message: expect.stringContaining('shell quoting'),
  } });
  expect(await cli(['--thread-id', 's', 'tool-spec', 'echo'])).toMatchObject({ ok: false, error: { code: 'CORE_RUNTIME_UNAVAILABLE' } });
});
it('CLI refuses hostile endpoint/DNS and symlink while allowing nonprivate Unix file modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pedelec-cli-parser-')); dirs.push(dir); await chmod(dir, 0o700);
  const file = join(dir, 'runtime.json');
  const args = ['--thread-id', 's', 'tool-spec', 'echo'];
  expect((await cli(args, file)).ok).toBe(false);
  for (const runtime of [
    { host: '0.0.0.0', port: 1234, endpoint: '0.0.0.0:1234' },
    { host: '127.0.0.1', port: 1234, endpoint: 'evil.example:1234' },
    { host: '127.0.0.1', port: 70000, endpoint: '127.0.0.1:70000' },
  ]) {
    await writeFile(file, JSON.stringify({ protocol: 'pedelec-core-ipc-v1', ...runtime }), { mode: 0o600 });
    expect((await cli(args, file)).error.code).toBe('IPC_UNAUTHORIZED');
  }
  const link = join(dir, 'link.json');
  try {
    await symlink(file, link);
    expect((await cli(args, link)).error.code).toBe('IPC_UNAUTHORIZED');
  } catch (error) {
    // Standard Windows accounts cannot always create file symlinks without Developer Mode.
    // Only omit this fixture assertion when the OS refused symlink creation itself.
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  // Local file mode is file hygiene, not process authorization. Valid discovery advances to connect.
  await writeFile(file, JSON.stringify({ protocol: 'pedelec-core-ipc-v1', host: '127.0.0.1',
    port: 1, endpoint: '127.0.0.1:1', generation: 'turn' }));
  await chmod(file, 0o644);
  await chmod(dir, 0o755);
  expect((await cli(args, file)).error.code).toBe('CORE_RUNTIME_UNAVAILABLE');
});
