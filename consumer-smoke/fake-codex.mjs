// Minimal fake Codex App Server for consumer smoke tests. It reports one native shell call (a failing `ls`), then runs
// the real packaged `pedelec-cli` found on the PATH the SDK injected, exactly like an Agent shell would.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const log = process.env.FAKE_CODEX_LOG;
const record = (value) => { if (log) appendFileSync(log, JSON.stringify(value) + '\n'); };
record({ pid: process.pid });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
let threadId = 'thread-smoke', sdkThreadId = '', activeTurn = '', turn = 0;

function runTools(turnId) {
  const command = `pedelec-cli --thread-id ${sdkThreadId} tool-call echoTool '{"text":"hi"}'`;
  send({ method: 'item/started', params: { threadId, turnId, item: { id: 'call-native', type: 'commandExecution', command: 'ls /definitely-missing', cwd: process.cwd(), status: 'inProgress' } } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'call-native', type: 'commandExecution', command: 'ls /definitely-missing', cwd: process.cwd(), status: 'failed', exitCode: 2, aggregatedOutput: 'ls: cannot access' } } });
  send({ method: 'item/started', params: { threadId, turnId, item: { id: 'call-cli', type: 'commandExecution', command, cwd: process.cwd(), status: 'inProgress' } } });
  execFile('pedelec-cli', ['--thread-id', sdkThreadId, 'tool-call', 'echoTool', '{"text":"hi"}'], { windowsHide: true }, (error, stdout, stderr) => {
    record({ cli: 'echoTool', failed: !!error, code: error?.code ?? 0, stdout, stderr });
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'call-cli', type: 'commandExecution', command, cwd: process.cwd(), status: error ? 'failed' : 'completed', exitCode: error ? 1 : 0, aggregatedOutput: stdout } } });
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm', delta: 'done' } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [{ id: 'm', type: 'agentMessage', text: 'done' }] } } });
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  record({ method: frame.method ?? null });
  if (frame.method === 'initialize') send({ id: frame.id, result: { userAgent: 'fake', codexHome: 'h', platformFamily: 'unix', platformOs: 'unix' } });
  else if (frame.method === 'thread/start') {
    sdkThreadId = /--thread-id (\S+)/.exec(frame.params?.developerInstructions ?? '')?.[1] ?? '';
    send({ id: frame.id, result: { thread: { id: threadId } } });
  } else if (frame.method === 'turn/start') {
    turn += 1; activeTurn = 'provider-turn-' + turn;
    send({ id: frame.id, result: { turn: { id: activeTurn } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: activeTurn, status: 'inProgress' } } });
    const text = JSON.stringify(frame.params?.input ?? '');
    if (text.includes('HANG')) return; // wait for turn/interrupt
    runTools(activeTurn);
  } else if (frame.method === 'turn/interrupt') {
    send({ id: frame.id, result: {} });
    send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'interrupted', items: [] } } });
  } else if (frame.id !== undefined) send({ id: frame.id, result: {} });
});
