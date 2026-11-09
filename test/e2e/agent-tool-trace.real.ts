/**
 * MD01/01A Gate B: real-Provider Level 1 Agent Tool Trace scenario (event-first contract). NOT part of `npm run test:sdk`: it launches a real,
 * logged-in Provider CLI that runs commands in a throw-away directory, so a human starts it deliberately.
 *
 *   cargo build -p pedelec-ipc-worker -p pedelec-cli --manifest-path rust/Cargo.toml
 *   node test/e2e/agent-tool-trace.real.ts --provider codex --model <model> [--effort medium] [--out <dir>]
 *
 * Writes trace.json (SDK events, values NOT redacted — keep the output private), provider-rpc.jsonl (the existing
 * Monitor provider.rpc view, with the Monitor's own unchanged redaction) and summary.json
 * (per-scenario observed facts and a PASS/FAIL/BLOCKED proposal) to --out. A human reviews the evidence before any
 * verdict enters the coverage matrix; a missing event is never read as "the Agent did not call a tool".
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createPedelecRuntime, defineTool, probeProviders, type AgentToolEvent, type PedelecMonitorEvent, type PedelecProvider } from '../../src/index.ts';

const { values } = parseArgs({ options: {
  provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string', default: 'medium' },
  out: { type: 'string' }, worker: { type: 'string' }, 'turn-timeout-ms': { type: 'string', default: '600000' },
} });
const provider = values.provider as PedelecProvider;
if (!provider || !values.model) throw new Error('usage: --provider <codex|claude|opencode|cursor|antigravity> --model <model>');
const repo = resolve(import.meta.dirname, '../..');
const worker = values.worker ?? resolve(repo, 'rust/target/debug', process.platform === 'win32' ? 'pedelec-ipc-worker.exe' : 'pedelec-ipc-worker');
const out = resolve(values.out ?? join(tmpdir(), `pedelec-agent-tool-trace-${provider}-${Date.now()}`));
mkdirSync(out, { recursive: true });
const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'pedelec-trace-e2e-')));
writeFileSync(join(workdir, 'note.txt'), 'hello from the trace scenario\n');
const turnTimeout = Number(values['turn-timeout-ms']);

const traceProbe = defineTool({ name: 'traceProbe', description: 'Scenario probe. mode ok succeeds, mode fail reports a tool failure.', argsSchema: {
  type: 'object', properties: { mode: { type: 'string', enum: ['ok', 'fail'] } }, required: ['mode'], additionalProperties: false,
} });
const scan = await probeProviders({ binaryPath: worker });
const sdk = await createPedelecRuntime({ rustIpc: { binaryPath: worker, cwd: workdir }, detailedMonitoring: true });
const session = await sdk.createSession({ provider, model: values.model, effort: values.effort, workdir, runtimeStorageRoot: join(out, 'runtime'), tools: [traceProbe] });
const events: AgentToolEvent[] = [];
const rpc: unknown[] = [];
const handled: string[] = [];
session.onAgentToolEvent((event) => { events.push(event); });
sdk.onMonitorEvent((event: PedelecMonitorEvent) => {
  if (event.sessionId === session.sessionId && event.kind === 'provider.rpc') rpc.push(event.data);
});
session.onTool('traceProbe', (args) => {
  const mode = (args as { mode: string }).mode;
  handled.push(mode);
  return mode === 'ok' ? { success: true, result: { probe: 'ok' } } : { success: false, result: { probe: 'requested failure' } };
});
const turn = (turnId: string) => new Promise<string>((resolveTurn) => {
  const timer = setTimeout(() => resolveTurn('TIMEOUT'), turnTimeout);
  const off = session.onTurnEnded((outcome) => { if (outcome.turnId === turnId) { clearTimeout(timer); off(); resolveTurn(outcome.terminal); } });
});

const cli = `pedelec-cli --thread-id ${session.sessionId}`;
const prompt = [
  'This is an automated tool-trace test. Perform every step in order, one tool call at a time. Do not skip, merge or retry steps.',
  '1. Use your shell tool to run exactly: echo trace-ok FAKE_TRACE_CANARY=sk-fake-canary-0000',
  '2. Use your shell tool to run exactly: ls /definitely-missing-pedelec-dir   (expected to fail)',
  '3. Use your native file-reading tool (not the shell) to read note.txt.',
  '4. If you have a native search tool (not the shell), search for "hello" in this directory.',
  `5. Use your shell tool to run exactly: ${cli} tool-spec traceProbe`,
  `6. Use your shell tool to run exactly: ${cli} tool-call traceProbe '{"mode":"ok"}'`,
  `7. Use your shell tool to run exactly: ${cli} tool-call traceProbe '{"mode":"fail"}'   (expected tool failure; do not retry)`,
  '8. Use your shell tool to run exactly: agent-browser --version   (report the error if it is not installed)',
  'Then reply with the single word DONE.',
].join('\n');
const first = turn('scenario');
await session.sendText(prompt, { turnId: 'scenario' });
const scenarioTerminal = await first;

// Cancel scenario: a long native shell call, cancelled once it is observed (or after 60 s).
const second = turn('cancel');
await session.sendText('Use your shell tool to run exactly: sleep 120   Then reply DONE.', { turnId: 'cancel' });
const seen = Date.now();
while (!events.some((e) => e.turnId === 'cancel' && e.kind === 'started') && Date.now() - seen < 60_000) await new Promise((r) => setTimeout(r, 250));
await session.cancel('trace scenario cancel').catch(() => undefined);
const cancelTerminal = await Promise.race([second, new Promise<string>((r) => setTimeout(() => r('NO_TERMINAL_IN_20S'), 20_000))]);
await session.close('trace scenario done').catch(() => undefined);
await sdk.close();
await new Promise((r) => setTimeout(r, 200));

const native = events.filter((e) => e.source === 'provider-native' && e.turnId === 'scenario');
const host = events.filter((e) => e.source === 'pedelec-host');
const finishedFor = (match: (e: AgentToolEvent) => boolean) => {
  const ids = new Set(native.filter((e) => e.toolKind === 'shell' && match(e)).map((e) => e.toolCallId));
  return native.filter((e) => ids.has(e.toolCallId) && e.kind === 'finished');
};
const commandHas = (text: string) => (e: AgentToolEvent) => JSON.stringify(e.input ?? '').includes(text);
const echo = finishedFor(commandHas('echo trace-ok'));
const ls = finishedFor(commandHas('definitely-missing-pedelec-dir'));
const browser = finishedFor(commandHas('agent-browser'));
const hostFinished = host.filter((e) => e.kind === 'finished');
/** Native Shell events that wrote `pedelec-cli tool-call traceProbe` (event-local hint; Host events stay a separate source). */
const toolCallShellIds = new Set(native.filter((e) => e.hostInvocations?.some((i) => i.subcommand === 'tool-call' && i.toolName === 'traceProbe')).map((e) => e.toolCallId));
const nativeToolCalls = native.filter((e) => toolCallShellIds.has(e.toolCallId));
/** 01A raw fidelity: the fake canary the Agent echoed reaches the listener verbatim (no redaction). */
const canaryVerbatim = echo.some((e) => JSON.stringify(e.output ?? '').includes('sk-fake-canary-0000'))
  || native.some((e) => JSON.stringify(e.input ?? '').includes('sk-fake-canary-0000'));
/** Event-first: no SDK-synthesised Tool terminal in any Turn. */
const synthetic = events.filter((e) => ['TOOL_RESULT_NOT_OBSERVED', 'WORKER_CRASHED', 'SESSION_FAULTED', 'SESSION_CLOSED'].includes(e.errorCode ?? '') && e.kind === 'finished');
const gaps = events.filter((e) => e.kind === 'observation-gap').map((e) => e.errorCode);
const unsupported = gaps.includes('PROVIDER_TRACE_UNSUPPORTED');
const verdict = (ok: boolean) => (unsupported ? 'BLOCKED' : ok ? 'PASS' : 'FAIL');
const cancelEvents = events.filter((e) => e.turnId === 'cancel');
const scenarios = {
  '1-native-shell': {
    verdict: verdict(echo.some((e) => e.status === 'completed') && ls.some((e) => e.status === 'failed' || (e.exitCode ?? 0) !== 0) && canaryVerbatim),
    canaryVerbatim,
    echo: echo.map((e) => ({ status: e.status, exitCode: e.exitCode ?? 'unavailable', unavailable: e.unavailable, output: e.output })),
    nonzero: ls.map((e) => ({ status: e.status, exitCode: e.exitCode ?? 'unavailable', unavailable: e.unavailable, output: e.output })),
  },
  '2-native-non-shell': {
    // Any non-shell native tool (file/search/mcp/browser/other) observed through to its Provider-reported finish.
    verdict: verdict(native.some((e) => e.kind === 'finished' && e.toolKind !== 'shell' && e.toolKind !== 'unknown')),
    tools: [...new Set(native.filter((e) => e.toolKind !== 'shell').map((e) => `${e.toolName}/${e.toolKind}`))],
  },
  '3-host-tool': {
    verdict: verdict(hostFinished.some((e) => e.status === 'completed') && hostFinished.some((e) => e.errorCode === 'TOOL_REPORTED_FAILURE')
      && hostFinished.length === handled.length && hostFinished.every((e) => e.correlation === 'unlinked' && !e.parentToolCallId)),
    handled, host: hostFinished.map((e) => ({ status: e.status, errorCode: e.errorCode, correlation: e.correlation, parent: e.parentToolCallId ?? null, output: e.output })),
    nativeShellToolCalls: nativeToolCalls.filter((e) => e.kind === 'finished').map((e) => ({ status: e.status, exitCode: e.exitCode ?? 'unavailable' })),
    toolSpecSeen: native.some((e) => e.hostInvocations?.some((i) => i.subcommand === 'tool-spec')),
    hostEventsWithoutHandler: host.filter((e) => e.kind === 'started').length - handled.length,
  },
  '4-agent-browser-shell': { verdict: verdict(browser.length > 0), calls: browser.map((e) => ({ status: e.status, exitCode: e.exitCode ?? 'unavailable', output: e.output })) },
  '5-cancel': {
    verdict: verdict(cancelEvents.some((e) => e.kind === 'started') && !cancelEvents.some((e) => e.kind === 'finished' && e.status === 'completed') && synthetic.length === 0),
    terminal: cancelTerminal, finished: cancelEvents.filter((e) => e.kind === 'finished').map((e) => ({ status: e.status, errorCode: e.errorCode })),
    providerReportedFinish: cancelEvents.some((e) => e.kind === 'finished'),
  },
  '6-event-first': {
    verdict: verdict(synthetic.length === 0 && events.every((e) => !('detailRedacted' in e))),
    syntheticTerminals: synthetic.length, duplicateProviderFrames: native.length - new Set(native.map((e) => `${e.toolCallId}/${e.kind}/${e.status}`)).size,
    lateObservations: events.filter((e) => e.lateObservation).length,
  },
};
const summary = {
  provider, model: values.model, providerVersion: scan?.[provider]?.version ?? null, platform: `${process.platform}-${process.arch}`,
  node: process.version, at: new Date().toISOString(), scenarioTerminal, eventCount: events.length, gaps, scenarios,
  note: 'Proposed verdicts only. Review trace.json and provider-rpc.jsonl; Provider fields that are absent must appear in `unavailable`.',
};
writeFileSync(join(out, 'trace.json'), JSON.stringify(events, null, 2));
writeFileSync(join(out, 'provider-rpc.jsonl'), rpc.map((r) => JSON.stringify(r)).join('\n'));
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, scenarioTerminal, verdicts: Object.fromEntries(Object.entries(scenarios).map(([k, v]) => [k, v.verdict])) }, null, 2));
