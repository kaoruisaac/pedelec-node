import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import AjvModule, { type ValidateFunction } from 'ajv';

// ajv is CommonJS: Node ESM sees `module.exports` (with `.default`), bundlers may see the class itself.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as typeof AjvModule.default;
import type { PedelecToolDescriptor } from '../types.ts';

/** A UUID needs no quoting in any shell; any other id keeps the shell's own quoting. */
function threadArgument(sessionId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(sessionId)) return sessionId;
  return process.platform === 'win32' ? `"${sessionId.replaceAll('"', '\\"')}"` : `'${sessionId.replaceAll("'", "'\\''")}'`;
}
export const cliCommands = (sessionId: string, toolName: string) => ({
  readSpecCommand: `pedelec-cli --thread-id ${threadArgument(sessionId)} tool-spec ${toolName}`,
  callCommand: `pedelec-cli --thread-id ${threadArgument(sessionId)} tool-call ${toolName} '<json_args>'`,
});

export type CliReply = { ok: boolean; result?: unknown; error?: { code: string; message: string } };
export const cliError = (code: string): CliReply => ({ ok: false, error: { code, message: code === 'TOOL_SCHEMA_INVALID'
  ? 'Tool arguments do not match the tool-spec argsSchema' : code } });
export type CliTarget = {
  activeTurn(): string | null;
  execute(id: string, name: string, args: unknown, deliver: (reply: CliReply) => Promise<void>): Promise<void>;
  /** Runs an upstream provider hook for the active turn. Rejection fails the hook, not the session. */
  artifactHook(stage: string, hookPayload: unknown): Promise<void>;
  unknown(): void;
  /** Observation only: a `tool_call` this endpoint refused before any handler ran. Must not throw or block. */
  refused?(requestId: string, toolName: string, args: unknown, code: string): void;
};
/** Covers the upstream 1 MiB hook payload; Tool arguments keep their own 64 KiB limit below. */
const LIMIT = 1024 * 1024;
const MAX_REQUESTS = 4096;

/** SDK-private trusted-local, bounded NDJSON Core IPC; not an OS process identity boundary. */
export class CliEndpoint {
  readonly runtimeFile: string;
  private readonly sockets = new Set<Socket>();
  private readonly cache = new Map<string, { identity: string; reply: Promise<CliReply> }>();
  private readonly validators = new Map<string, ValidateFunction>();
  private target?: CliTarget;
  private closed = false;
  private pending = false;
  private generation = randomBytes(16).toString('hex');
  private runtime: Record<string, unknown> = {};
  private readonly directory: string;
  private readonly server: Server;
  private readonly sessionId: string;
  private readonly tools: readonly PedelecToolDescriptor[];
  private constructor(directory: string, server: Server, sessionId: string, tools: readonly PedelecToolDescriptor[]) {
    this.directory = directory; this.server = server; this.sessionId = sessionId; this.tools = tools;
    this.runtimeFile = join(directory, 'runtime.json');
    // Local schemas only. Unknown keywords/remote references fail creation, never silently skip validation.
    // `required` may name a property of any JSON type, which has no `properties` entry to declare.
    const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: false, validateFormats: true });
    for (const tool of tools) this.validators.set(tool.name, ajv.compile(tool.argsSchema));
  }

  static async start(sessionId: string, tools: readonly PedelecToolDescriptor[]): Promise<CliEndpoint> {
    const directory = await mkdtemp(join(tmpdir(), 'pedelec-cli-'));
    let endpoint: CliEndpoint | undefined;
    const server = createServer((socket) => endpoint?.accept(socket));
    try {
      // Best-effort local file hygiene only; not a process-isolation or authorization gate.
      if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => undefined);
      endpoint = new CliEndpoint(directory, server, sessionId, tools);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('CLI_LISTEN_FAILED');
      endpoint.runtime = { protocol: 'pedelec-core-ipc-v1', host: '127.0.0.1', port: address.port,
        endpoint: `127.0.0.1:${address.port}`, pid: process.pid };
      await endpoint.rotate();
      return endpoint;
    } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }

  bind(target: CliTarget): void { this.target = target; }
  async rotate(): Promise<void> {
    if (this.closed) throw new Error('CLI_ENDPOINT_CLOSED');
    this.generation = randomBytes(16).toString('hex');
    await writeFile(this.runtimeFile, JSON.stringify({ ...this.runtime, generation: this.generation }), { mode: 0o600 });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    this.cache.clear();
    await rm(this.directory, { recursive: true, force: true });
  }
  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setTimeout(125_000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > LIMIT) { socket.end(JSON.stringify(cliError('MESSAGE_TOO_LARGE')) + '\n'); socket.removeAllListeners('data'); return; }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      socket.removeAllListeners('data');
      let request: unknown;
      try { request = JSON.parse(bytes.subarray(0, end).toString('utf8')); }
      catch { socket.end(JSON.stringify(cliError('INVALID_INPUT')) + '\n'); return; }
      const req = request as Record<string, unknown> | null;
      const id = typeof req?.requestId === 'string' ? req.requestId : '';
      let delivered = false;
      let executing = false;
      socket.once('close', () => { if (executing && !delivered) this.target?.unknown(); });
      const deliver = (reply: CliReply) => new Promise<void>((resolve, reject) => {
        if (delivered || socket.destroyed || !socket.writable) { reject(new Error('CLI_DELIVERY_UNKNOWN')); return; }
        delivered = true;
        const failed = () => reject(new Error('CLI_DELIVERY_UNKNOWN'));
        const timer = setTimeout(() => { failed(); socket.destroy(); }, 3000);
        socket.once('error', failed);
        socket.once('close', failed);
        socket.end(JSON.stringify({ requestId: id, ...reply }) + '\n', () => {
          clearTimeout(timer); socket.removeListener('error', failed); socket.removeListener('close', failed); resolve();
        });
      });
      void this.dispatch(request, deliver, () => { executing = true; }).then(async (reply) => { if (!delivered) await deliver(reply); }).catch(() => {
        this.target?.unknown(); socket.destroy();
      });
    });
  }
  private async dispatch(value: unknown, deliver: (reply: CliReply) => Promise<void>, onStarted: () => void): Promise<CliReply> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return cliError('INVALID_INPUT');
    const req = value as Record<string, unknown>;
    if (this.closed) return cliError('SESSION_NOT_ACTIVE');
    // Reject old token-bearing requests; no dual-protocol fallback.
    if (Object.keys(req).some((k) => !['requestId', 'type', 'payload', 'generation'].includes(k))) return cliError('INVALID_INPUT');
    if (typeof req.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.requestId)) return cliError('INVALID_INPUT');
    const p = req.payload as Record<string, unknown> | null;
    // The hook runs under the provider, which names its conversation, not the SDK session.
    if (req.type === 'provider_artifact_hook') return this.artifactHook(req, p);
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.threadId !== this.sessionId) return cliError('THREAD_ACCESS_DENIED');
    if (Object.keys(p).some((k) => !['threadId', 'toolName', 'args'].includes(k))) return cliError('INVALID_INPUT');
    // A refused tool_call is still an Agent Tool Invocation: report it, then refuse exactly as before.
    const refuse = (code: string): CliReply => {
      if (req.type === 'tool_call' && typeof p.toolName === 'string') {
        try { this.target?.refused?.(req.requestId as string, p.toolName, p.args, code); } catch { /* Observation only. */ }
      }
      return cliError(code);
    };
    if (req.generation !== this.generation) return refuse('STALE_TURN');
    const tool = this.tools.find((tool) => tool.name === p.toolName);
    if (!tool) return refuse('TOOL_NOT_FOUND');
    if (req.type === 'tool_spec') return { ok: true, result: { ...tool, schema: tool.argsSchema, ...cliCommands(this.sessionId, tool.name) } };
    if (req.type !== 'tool_call') return cliError('INVALID_INPUT');
    const turn = this.target?.activeTurn();
    if (!turn) return refuse('SESSION_NOT_ACTIVE');
    const identity = JSON.stringify([this.sessionId, turn, req.generation, tool.name, p.args]);
    const cached = this.cache.get(req.requestId);
    if (cached) return cached.identity === identity ? cached.reply : refuse('REQUEST_ID_CONFLICT');
    if (!Object.hasOwn(p, 'args') || Buffer.byteLength(JSON.stringify(p.args) ?? '') > 64 * 1024) return refuse('TOOL_ARGS_INVALID');
    if (!this.validators.get(tool.name)!(p.args)) return refuse('TOOL_SCHEMA_INVALID');
    if (this.pending) return refuse('TOOL_PENDING');
    if (this.cache.size >= MAX_REQUESTS) return refuse('REQUEST_LIMIT');
    this.pending = true;
    onStarted();
    let settle!: (reply: CliReply) => void;
    const reply = new Promise<CliReply>((resolve) => { settle = resolve; });
    this.cache.set(req.requestId, { identity, reply });
    try {
      await this.target!.execute(req.requestId, tool.name, p.args, async (result) => {
        // Cache before sending: ambiguous writes cannot trigger a second execution.
        settle(result);
        await deliver(result);
      });
      settle(cliError('OUTCOME_UNKNOWN'));
    } catch { settle(cliError('OUTCOME_UNKNOWN')); this.target?.unknown(); }
    finally { this.pending = false; }
    return reply;
  }
  private async artifactHook(req: Record<string, unknown>, p: Record<string, unknown> | null): Promise<CliReply> {
    if (!p || typeof p !== 'object' || Array.isArray(p) || req.generation !== this.generation) return cliError('STALE_TURN');
    if (Object.keys(p).some((k) => !['provider', 'stage', 'hookPayload'].includes(k)) || p.provider !== 'antigravity'
      || (p.stage !== 'before' && p.stage !== 'after')) return cliError('INVALID_INPUT');
    if (!this.target?.activeTurn()) return cliError('SESSION_NOT_ACTIVE');
    try { await this.target.artifactHook(p.stage, p.hookPayload); return { ok: true, result: {} }; }
    catch { return cliError('PROVIDER_ARTIFACT_HOOK_FAILED'); }
  }
}
