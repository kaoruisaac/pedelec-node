// External consumer smoke for @kaoruisaac/pedelec-node.
//
// Run from a clean directory that installed the packed tarball (never from the source repository):
//   npm init -y && npm install /path/to/kaoruisaac-pedelec-node-<v>.tgz && node smoke.mjs [--report report.json]
//
// It imports only the public package entry, uses a fake Codex App Server (no account needed) and the packaged
// pedelec-ipc-worker / pedelec-cli, and checks: native verification, createSession, Native Tool Trace, CLI Host Tool →
// onTool, cancel, close, process cleanup, Host SIGTERM cleanup, and fail-closed install damage / absent Provider.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as sdkModule from '@kaoruisaac/pedelec-node';

const { values } = parseArgs({ options: { report: { type: 'string' }, 'child-host': { type: 'string' }, hold: { type: 'boolean', default: false } } });
const here = dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@kaoruisaac/pedelec-node'))), '..');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${label}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, error: String(error?.stack ?? error) });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

/** Fake provider wrapper the Worker can launch on this OS. */
function fakeProvider(dir) {
  const module = join(here, 'fake-codex.mjs');
  if (win) {
    const wrapper = join(dir, 'fake-codex.cmd');
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${module}" %*\r\n`);
    return wrapper;
  }
  const wrapper = join(dir, 'fake-codex.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${module}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function workspace(label) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pedelec smoke ${label} `)));
  const log = join(dir, 'provider.jsonl');
  writeFileSync(log, '');
  return { dir, log, env: { ...process.env, PEDELEC_CODEX_PATH: fakeProvider(dir), FAKE_CODEX_LOG: log } };
}
const readLog = (log) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Processes still running from this package's native bin directory. */
function nativeProcesses() {
  const binDir = join(packageRoot, 'bin');
  if (win) {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true });
    const rows = JSON.parse(ps.stdout || '[]');
    return (Array.isArray(rows) ? rows : [rows]).filter((r) => r.ExecutablePath && r.ExecutablePath.toLowerCase().startsWith(binDir.toLowerCase())).map((r) => r.ProcessId);
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps.stdout.split('\n').filter((l) => l.includes(binDir)).map((l) => Number.parseInt(l.trim(), 10));
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const echoTool = sdkModule.defineTool({ name: 'echoTool', description: 'Echo text back.', argsSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });

// ---------------------------------------------------------------- child host for the SIGTERM scenario
if (values['child-host']) {
  const ws = JSON.parse(values['child-host']);
  const sdk = await sdkModule.createPedelecRuntime({ rustIpc: { cwd: ws.dir, env: ws.env } });
  const session = await sdk.createSession({ provider: 'codex', model: 'fake', effort: 'default', workdir: ws.dir, runtimeStorageRoot: join(ws.dir, 'runtime'), tools: [] });
  await session.sendText('HANG please', { turnId: 'hang' });
  console.log('READY');
  setInterval(() => {}, 1000);
} else if (values.hold) {
  // Container SIGTERM scenario: a Host that closes its runtime on SIGTERM; `docker stop` must finish within its grace.
  const ws = workspace('hold');
  const sdk = await sdkModule.createPedelecRuntime({ rustIpc: { cwd: ws.dir, env: ws.env } });
  const session = await sdk.createSession({ provider: 'codex', model: 'fake', effort: 'default', workdir: ws.dir, runtimeStorageRoot: join(ws.dir, 'runtime'), tools: [] });
  await session.sendText('HANG please', { turnId: 'hold' });
  process.once('SIGTERM', async () => {
    const started = Date.now();
    await sdk.close();
    const closedMs = Date.now() - started;
    try { await waitFor(() => nativeProcesses().length === 0, 5_000, 'native exit'); } catch { /* reported below */ }
    const leftover = nativeProcesses().length;
    console.log(JSON.stringify({ sigterm: 'closed', closeMs: closedMs, exitedMs: Date.now() - started, leftover }));
    process.exit(leftover === 0 ? 0 : 3);
  });
  console.log('READY');
  setInterval(() => {}, 1000);
} else {
  await main();
}

async function main() {
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, packageRoot }));

  await step('public entry exports only the SDK surface', () => {
    const names = Object.keys(sdkModule).sort();
    for (const required of ['createPedelecRuntime', 'defineTool', 'PedelecError', 'nativeRuntimeInfo', 'probeProviders', 'AGENT_TOOL_TRACE_LIMITS']) assert(names.includes(required), `missing export ${required}`);
    for (const internal of ['RustIpcSupervisor', 'resolveNativeBundle', 'defaultWorkerPath']) assert(!names.includes(internal), `internal export leaked: ${internal}`);
    return { exports: names };
  });

  await step('private deep imports are refused by package exports', async () => {
    for (const deep of ['@kaoruisaac/pedelec-node/dist/transport/rust-ipc-supervisor.mjs', '@kaoruisaac/pedelec-node/src/index.ts']) {
      let refused = false;
      try { await import(deep); } catch (error) { refused = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
      assert(refused, `deep import was not refused: ${deep}`);
    }
  });

  let info;
  await step('native runtime verifies against the manifest', () => {
    info = sdkModule.nativeRuntimeInfo();
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'bin', 'manifest.json'), 'utf8'));
    if (process.env.SMOKE_ALLOW_PARTIAL !== '1') assert(Object.keys(manifest.targets).sort().join() === 'darwin-arm64,linux-x64-gnu,win32-x64', `package must ship all three targets, has ${Object.keys(manifest.targets)}`);
    const versions = {};
    for (const name of ['pedelec-ipc-worker', 'pedelec-agent', 'pedelec-cli']) {
      const out = spawnSync(join(packageRoot, 'bin', info.target, name + (win ? '.exe' : '')), ['--version'], { encoding: 'utf8', windowsHide: true });
      assert(out.status === 0, `${name} --version exited ${out.status}`);
      const parsed = JSON.parse(out.stdout);
      assert(parsed.version === info.version && parsed.protocolVersion === 1, `${name} version mismatch: ${out.stdout}`);
      versions[name] = parsed.version;
    }
    if (process.platform === 'linux') {
      const ldd = spawnSync('ldd', [join(packageRoot, 'bin', info.target, 'pedelec-ipc-worker')], { encoding: 'utf8' });
      versions.ldd = ldd.stdout.trim().split('\n').map((l) => l.trim().split(' ')[0]);
      assert(!/not found/.test(ldd.stdout), `unresolved shared library: ${ldd.stdout}`);
    }
    return { ...info, versions };
  });

  await step('session → native trace → pedelec-cli → onTool → close → cleanup', async () => {
    const ws = workspace('main');
    const sdk = await sdkModule.createPedelecRuntime({ rustIpc: { cwd: ws.dir, env: ws.env } });
    const session = await sdk.createSession({ provider: 'codex', model: 'fake', effort: 'default', workdir: ws.dir, runtimeStorageRoot: join(ws.dir, 'runtime'), tools: [echoTool] });
    const events = [], outcomes = [], handled = [], chats = [];
    session.onAgentToolEvent((event) => { events.push(event); });
    session.onTool('echoTool', (args, ctx) => { handled.push({ args, toolCallId: ctx.toolCallId }); return { success: true, result: { echoed: args.text } }; });
    session.onTurnEnded((o) => { outcomes.push(o); });
    session.onChat((text) => { chats.push(text); });
    await session.sendText('Run the tools.', { turnId: 'turn-tools' });
    await waitFor(() => outcomes.length === 1, 20_000, 'turn end');
    const log = readLog(ws.log);
    const cli = log.find((r) => r.cli);
    assert(cli && !cli.failed, `pedelec-cli failed: ${JSON.stringify(cli)}`);
    assert(JSON.parse(cli.stdout).ok === true, `pedelec-cli reply not ok: ${cli.stdout}`);
    assert(handled.length === 1 && handled[0].args.text === 'hi', `onTool calls: ${JSON.stringify(handled)}`);
    assert(outcomes[0].terminal === 'completed', `turn outcome ${JSON.stringify(outcomes[0])}`);
    const native = events.filter((e) => e.source === 'provider-native' && e.nativeToolCallId === 'call-native');
    assert(native.some((e) => e.kind === 'started') && native.some((e) => e.kind === 'finished' && e.status === 'failed' && e.exitCode === 2), `native shell trace: ${JSON.stringify(native)}`);
    const host = events.filter((e) => e.source === 'pedelec-host' && e.toolName === 'echoTool');
    assert(host.some((e) => e.kind === 'finished' && e.status === 'completed'), `host trace: ${JSON.stringify(host)}`);
    assert(host.some((e) => e.hostToolCallId === handled[0].toolCallId), 'host trace does not carry the onTool toolCallId');
    const providerPid = log.find((r) => r.pid)?.pid;
    assert(nativeProcesses().length > 0, 'expected a running native worker before close');
    await session.close('smoke complete');
    await sdk.close();
    await waitFor(() => nativeProcesses().length === 0 && !alive(providerPid), 10_000, 'native/provider process exit');
    rmSync(ws.dir, { recursive: true, force: true });
    return { events: events.length, kinds: [...new Set(events.map((e) => `${e.source}:${e.toolKind}:${e.kind}`))], chats };
  });

  await step('cancel interrupts the active turn without replay', async () => {
    const ws = workspace('cancel');
    const sdk = await sdkModule.createPedelecRuntime({ rustIpc: { cwd: ws.dir, env: ws.env } });
    const session = await sdk.createSession({ provider: 'codex', model: 'fake', effort: 'default', workdir: ws.dir, runtimeStorageRoot: join(ws.dir, 'runtime'), tools: [] });
    const outcomes = [];
    session.onTurnEnded((o) => { outcomes.push(o); });
    await session.sendText('HANG until cancelled', { turnId: 'turn-hang' });
    await session.cancel('smoke cancel');
    await waitFor(() => outcomes.length === 1, 15_000, 'cancelled turn end');
    assert(outcomes[0].cancelRequested === true, `outcome ${JSON.stringify(outcomes[0])}`);
    const starts = readLog(ws.log).filter((r) => r.method === 'turn/start').length;
    assert(starts === 1, `turn/start sent ${starts} times`);
    await sdk.close();
    await waitFor(() => nativeProcesses().length === 0, 10_000, 'native process exit');
    rmSync(ws.dir, { recursive: true, force: true });
    return { outcome: outcomes[0] };
  });

  await step('Host process SIGTERM leaves no native or provider process', async () => {
    const ws = workspace('sigterm');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child-host', JSON.stringify(ws)], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let ready = false;
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) ready = true; });
    await waitFor(() => ready, 20_000, 'child host ready');
    const providerPid = readLog(ws.log).find((r) => r.pid)?.pid;
    assert(providerPid && alive(providerPid), 'provider not running in child host');
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    await waitFor(() => nativeProcesses().length === 0 && !alive(providerPid), 15_000, 'orphan cleanup after host SIGTERM');
    rmSync(ws.dir, { recursive: true, force: true });
  });

  await step('absent Provider CLI fails closed without leaking paths', async () => {
    const ws = workspace('absent');
    const missing = join(ws.dir, 'no-such-cursor-agent');
    const sdk = await sdkModule.createPedelecRuntime({ rustIpc: { cwd: ws.dir, env: { ...ws.env, PEDELEC_CURSOR_PATH: missing } } });
    let error;
    try { await sdk.createSession({ provider: 'cursor', model: 'auto', effort: 'default', workdir: ws.dir, runtimeStorageRoot: join(ws.dir, 'runtime'), tools: [] }); }
    catch (e) { error = e; }
    await sdk.close();
    assert(error instanceof sdkModule.PedelecError, `expected PedelecError, got ${error}`);
    assert(!String(error.message).includes(ws.dir), 'error message leaks a host path');
    rmSync(ws.dir, { recursive: true, force: true });
    return { code: error.code, transportCode: error.transportCode, message: error.message };
  });

  // Damaged installs: copies of the installed package (so the real install is untouched) imported by file URL.
  const damage = [
    ['tampered binary', 'NATIVE_MANIFEST_MISMATCH', (root, t) => appendFileSync(join(root, 'bin', t, `pedelec-cli${win ? '.exe' : ''}`), 'x')],
    ['missing binary', 'NATIVE_BINARY_MISSING', (root, t) => unlinkSync(join(root, 'bin', t, `pedelec-agent${win ? '.exe' : ''}`))],
    ['SDK/manifest version mismatch', 'NATIVE_MANIFEST_MISMATCH', (root) => {
      const file = join(root, 'package.json'); const pkg = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...pkg, version: '999.0.0' }));
    }],
    ['missing manifest', 'NATIVE_MANIFEST_MISSING', (root) => unlinkSync(join(root, 'bin', 'manifest.json'))],
    ...(win ? [] : [['symlinked binary', 'NATIVE_BINARY_INVALID', (root, t) => {
      const file = join(root, 'bin', t, 'pedelec-ipc-worker');
      const elsewhere = join(root, 'elsewhere-worker'); cpSync(file, elsewhere); unlinkSync(file); symlinkSync(elsewhere, file);
    }]]),
  ];
  for (const [label, code, mutate] of damage) {
    await step(`fail-closed: ${label}`, async () => {
      const root = join(here, 'damaged', label.replace(/\W+/g, '-'));
      rmSync(root, { recursive: true, force: true });
      mkdirSync(dirname(root), { recursive: true });
      cpSync(packageRoot, root, { recursive: true, verbatimSymlinks: true });
      mutate(root, info?.target ?? 'unknown');
      const copy = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
      let error;
      try { await copy.createPedelecRuntime(); } catch (e) { error = e; }
      rmSync(root, { recursive: true, force: true });
      assert(error && error.code === 'TRANSPORT_UNAVAILABLE' && error.transportCode === code, `expected ${code}, got ${error?.transportCode ?? error}`);
      return { message: error.message };
    });
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  const report = { package: '@kaoruisaac/pedelec-node', version: info?.version, target: info?.target, node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? null, at: new Date().toISOString(), results };
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length }));
  process.exit(failed.length ? 1 : 0);
}
