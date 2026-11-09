import { EventEmitter } from 'node:events';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { resolveNativeBundle } from './native-bundle.mjs';

export const IPC_VERSION = 1;
export const MAX_IPC_FRAME_BYTES = 1024 * 1024;

// Source-level wiring, not runtime availability or verification evidence. A successful open
// must still confirm the worker receipt. `hostTools` means the `pedelec-cli` loop is wired for
// this Provider; `toolReply` stays false for all of them because no Provider has a native ACK.
const runtime = (cancel) => Object.freeze({
  supported: true, openSession: true, send: true, closeSession: true,
  resumeProvider: true, cancel, toolReply: false, hostTools: true,
});
export const PROVIDER_CAPABILITIES = Object.freeze({
  codex: runtime('native'),
  claude: runtime('native'),
  cursor: runtime('native'),
  opencode: runtime('native'),
  ollama: runtime('native'),
  antigravity: runtime('process-stop'),
});

export class RustIpcError extends Error {
  constructor(code, message, { retryable = false, requestId = undefined } = {}) {
    super(message);
    this.name = 'RustIpcError';
    this.code = code;
    this.retryable = retryable;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

/** This platform's verified packaged Worker. Throws a NativeBundleError instead of guessing another path. */
export function defaultWorkerPath() {
  return resolveNativeBundle().worker;
}

function validateId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value) > 128) {
    throw new TypeError(`${name} must be a non-empty string of at most 128 bytes`);
  }
}

function errorFromReply(reply) {
  if (!reply.error || typeof reply.error.code !== 'string' || typeof reply.error.message !== 'string') {
    return new RustIpcError('INVALID_REPLY', 'Rust worker returned an invalid error frame', { requestId: reply.requestId });
  }
  return new RustIpcError(reply.error.code, reply.error.message, {
    retryable: reply.error.retryable === true,
    requestId: reply.requestId,
  });
}

/** SDK-private: owns one Rust worker process. Session/Turn state lives in ../session.ts; authorization and persistence stay in the Server. */
export class RustIpcSupervisor extends EventEmitter {
  static async start({
    binaryPath = defaultWorkerPath(),
    cwd,
    env = process.env,
    spawn = spawnChild,
    startTimeoutMs = 5000,
    maxFrameBytes = MAX_IPC_FRAME_BYTES,
    detailedMonitoring = false,
  } = {}) {
    if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) {
      throw new TypeError('binaryPath must be an absolute path');
    }
    if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) {
      throw new TypeError('cwd must be an absolute path');
    }
    const supervisor = new RustIpcSupervisor({ binaryPath, cwd, env, spawn, startTimeoutMs, maxFrameBytes, detailedMonitoring });
    await supervisor.#start();
    return supervisor;
  }

  constructor({ binaryPath, cwd, env, spawn, startTimeoutMs, maxFrameBytes, detailedMonitoring = false }) {
    super();
    this.binaryPath = binaryPath;
    this.cwd = cwd;
    this.env = env;
    this.spawnChild = spawn;
    this.startTimeoutMs = startTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.detailedMonitoring = detailedMonitoring === true;
    this.child = undefined;
    this.pending = new Map();
    this.timedOutIds = new Set();
    this.sequences = new Map();
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stdoutBuffer = '';
    this.stderrBytes = 0;
    this.closed = false;
    this.expectedExit = false;
    this.exitEvidence = undefined;
    this.writeQueue = Promise.resolve();
    /** Provider trees the Worker placed outside its own process group. */
    this.ownedGroups = new Set();
    this.forcedStop = false;
  }

  async #start() {
    this.child = this.spawnChild(this.binaryPath, [], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const child = this.child;
    child.stdin.on('error', () => {
      this.#fail(new RustIpcError('WORKER_WRITE_FAILED', 'Rust worker input closed'));
    });
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBytes += chunk.length;
      this.emit('diagnostic', { byteCount: chunk.length });
      this.#observe({ kind: 'worker.stderr', bytes: chunk.length });
    });
    child.once('error', (error) => {
      this.#fail(new RustIpcError('WORKER_SPAWN_FAILED', `Rust worker could not start: ${error.code || 'process error'}`));
    });
    child.once('close', (code, signal) => this.#onExit(code, signal));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new RustIpcError('WORKER_START_TIMEOUT', 'Rust worker did not start before the deadline'));
        void this.terminate({ graceMs: 100 });
      }, this.startTimeoutMs);
      child.once('spawn', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(new RustIpcError('WORKER_SPAWN_FAILED', `Rust worker could not start: ${error.code || 'process error'}`));
      });
    });
  }

  get pid() {
    return this.child?.pid;
  }

  request({ requestId = randomUUID(), sessionId, op, payload }, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new RustIpcError('WORKER_CLOSED', 'Rust worker is closed'));
    validateId(requestId, 'requestId');
    if (typeof op !== 'string' || op.trim().length === 0 || Buffer.byteLength(op) > 128) {
      throw new TypeError('op must be a non-empty string of at most 128 bytes');
    }
    if (sessionId !== undefined) validateId(sessionId, 'sessionId');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
    if (this.pending.has(requestId) || this.timedOutIds.has(requestId)) {
      throw new RustIpcError('DUPLICATE_REQUEST_ID', 'requestId is already in flight or recently timed out', { requestId });
    }
    const frame = { version: IPC_VERSION, requestId, ...(sessionId === undefined ? {} : { sessionId }), op, payload };
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line) - 1 > this.maxFrameBytes) {
      throw new RustIpcError('FRAME_TOO_LARGE', 'IPC request exceeds the frame limit', { requestId });
    }

    const startedAt = Date.now();
    this.#observe({ kind: 'transport.request', op, id: requestId, bytes: Buffer.byteLength(line), frame });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.#rememberTimedOut(requestId);
        this.#observeReply({ op, startedAt }, requestId, 'timeout', 0);
        reject(new RustIpcError('IPC_TIMEOUT', `Rust worker request timed out: ${op}`, { requestId }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, op, startedAt });
    });
    this.writeQueue = this.writeQueue.then(() => new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable || this.closed) {
        reject(new RustIpcError('WORKER_CLOSED', 'Rust worker stdin is closed', { requestId }));
        return;
      }
      this.child.stdin.write(line, (error) => error ? reject(error) : resolve());
    })).catch((error) => {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        this.#observeReply(pending, requestId, 'write-failed', 0);
        pending.reject(error instanceof RustIpcError ? error : new RustIpcError('WORKER_WRITE_FAILED', 'Rust worker request could not be written', { requestId }));
      }
      this.#fail(new RustIpcError('WORKER_WRITE_FAILED', 'Rust worker request could not be written'));
    });
    return promise;
  }

  openSession({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'open-session', payload }, options).then(reply => {
      this.validateOpen(reply.data, payload); return reply;
    });
  }

  validateOpen(data, payload, attach = false) {
    if (!data || data.provider !== payload.provider || data.runtimeStarted !== true
      || typeof data.providerSessionId !== 'string' || !data.providerSessionId.trim()
      || Buffer.byteLength(data.providerSessionId) > 512 || /[\u0000-\u001f]/.test(data.providerSessionId)
      || !data.capabilities || data.capabilities['send'] !== 'supported'
      || data.capabilities['close-session'] !== 'supported'
      || (attach && (data.rehydrated !== true || data.providerSessionId !== payload.providerSessionId))) {
      throw new RustIpcError('INVALID_REPLY', 'Worker did not confirm provider capabilities');
    }
  }

  rehydrateSession({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'rehydrate-session', payload }, options).then(reply => {
      this.validateOpen(reply.data, payload, true); return reply;
    });
  }

  send({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'send', payload }, options);
  }

  cancel({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'cancel', payload }, options);
  }

  closeSession({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'close-session', payload }, options);
  }

  resumeProvider({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'resume-provider', payload }, options);
  }

  toolReply({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'tool-reply', payload }, options);
  }

  providerArtifactHook({ requestId, sessionId, ...payload }, options) {
    return this.request({ requestId, sessionId, op: 'provider-artifact-hook', payload }, options);
  }

  async shutdown({ graceMs = 1000, timeoutMs = 5000 } = {}) {
    if (this.closed) return this.exitEvidence;
    this.expectedExit = true;
    try {
      await this.request({ op: 'shutdown', payload: { graceMs } }, { timeoutMs });
    } catch (error) {
      if (!(error instanceof RustIpcError) || !['WORKER_CLOSED', 'IPC_TIMEOUT', 'WORKER_EXITED'].includes(error.code)) throw error;
    }
    if (!this.closed) await this.#waitForExit(timeoutMs);
    if (!this.closed) await this.terminate({ graceMs: Math.min(graceMs, 1000) });
    return this.exitEvidence;
  }

  async terminate({ signal = 'SIGTERM', graceMs = 1000 } = {}) {
    if (this.closed || !this.child?.pid) return this.exitEvidence;
    this.expectedExit = true;
    this.forcedStop = true;
    try {
      this.#signalTree(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') this.emit('diagnostic', { byteCount: 0, code: 'TREE_SIGNAL_FAILED' });
    }
    await this.#waitForExit(graceMs);
    if (!this.closed) {
      try { this.#signalTree('SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') this.emit('diagnostic', { byteCount: 0, code: 'TREE_KILL_FAILED' });
      }
      await this.#waitForExit(Math.max(graceMs, 100));
    }
    return this.exitEvidence;
  }

  #signalTree(signal) {
    if (process.platform !== 'win32') {
      process.kill(-this.child.pid, signal);
      return;
    }
    const result = spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true });
    if (result.status !== 0) throw Object.assign(new Error('taskkill failed'), { code: 'TREE_SIGNAL_FAILED' });
  }

  #waitForExit(timeoutMs) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.once('exitEvidence', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #rememberTimedOut(requestId) {
    this.timedOutIds.add(requestId);
    if (this.timedOutIds.size > 4096) this.timedOutIds.delete(this.timedOutIds.values().next().value);
  }

  #onStdout(chunk) {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxFrameBytes && !this.stdoutBuffer.includes('\n')) {
      this.#fail(new RustIpcError('WORKER_FRAME_TOO_LARGE', 'Rust worker emitted an oversized unterminated frame'));
      void this.terminate({ graceMs: 100 });
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.#fail(new RustIpcError('WORKER_FRAME_TOO_LARGE', 'Rust worker emitted an oversized frame'));
        void this.terminate({ graceMs: 100 });
        return;
      }
      this.#consumeFrame(line);
    }
  }

  #consumeFrame(line) {
    let frame;
    try { frame = JSON.parse(line); } catch {
      this.#fail(new RustIpcError('INVALID_REPLY', 'Rust worker emitted malformed JSON'));
      void this.terminate({ graceMs: 100 });
      return;
    }
    if (frame?.version !== IPC_VERSION) {
      this.#fail(new RustIpcError('UNSUPPORTED_VERSION', 'Rust worker emitted an unsupported protocol version'));
      void this.terminate({ graceMs: 100 });
      return;
    }
    if (typeof frame.requestId === 'string') {
      const pending = this.pending.get(frame.requestId);
      if (!pending && this.timedOutIds.has(frame.requestId)) {
        this.timedOutIds.delete(frame.requestId);
        this.emit('lateReply', { requestId: frame.requestId });
        this.#observe({ kind: 'transport.late-reply', id: frame.requestId, bytes: Buffer.byteLength(line), frame });
        return;
      }
      if (!pending || typeof frame.ok !== 'boolean') {
        this.#fail(new RustIpcError('INVALID_REPLY', 'Rust worker reply did not match an in-flight request'));
        void this.terminate({ graceMs: 100 });
        return;
      }
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      this.#observeReply(pending, frame.requestId, frame.ok ? 'ok' : (typeof frame.error?.code === 'string' ? frame.error.code : 'error'), Buffer.byteLength(line), frame);
      if (frame.ok) pending.resolve({ requestId: frame.requestId, data: frame.data });
      else pending.reject(errorFromReply(frame));
      return;
    }
    if (typeof frame.sessionId === 'string' && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 && typeof frame.kind === 'string') {
      const previous = this.sequences.get(frame.sessionId) || 0;
      if (frame.sequence <= previous) {
        this.#fail(new RustIpcError('EVENT_SEQUENCE_REVERSED', 'Rust worker event sequence did not increase'));
        void this.terminate({ graceMs: 100 });
        return;
      }
      this.sequences.set(frame.sessionId, frame.sequence);
      if (frame.kind === 'process-tree' && Number.isSafeInteger(frame.data?.pid) && frame.data.pid > 1) this.ownedGroups.add(frame.data.pid);
      this.emit('event', { sessionId: frame.sessionId, sequence: frame.sequence, kind: frame.kind, data: frame.data });
      return;
    }
    this.#fail(new RustIpcError('INVALID_REPLY', 'Rust worker emitted an unknown frame'));
    void this.terminate({ graceMs: 100 });
  }

  #onExit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    const evidence = {
      pid: this.child?.pid,
      code,
      signal,
      expected: this.expectedExit,
      stderrBytes: this.stderrBytes,
      at: new Date().toISOString(),
    };
    this.exitEvidence = evidence;
    this.#observe({ kind: 'worker.exited', pid: evidence.pid, code, signal, expected: evidence.expected, stderrBytes: evidence.stderrBytes });
    if (!this.expectedExit || this.forcedStop) this.#reapOrphans();
    const error = new RustIpcError('WORKER_EXITED', `Rust worker exited (${signal || code})`);
    this.#rejectPending(error);
    this.emit('exitEvidence', evidence);
    if (!this.expectedExit) this.emit('crash', evidence);
  }

  /** A dead Worker cannot stop its providers. Its group outlives it while any member remains. */
  #reapOrphans() {
    // Windows providers sit in kill-on-close Jobs, which ended with the Worker.
    if (process.platform === 'win32') return;
    for (const group of [this.child?.pid, ...this.ownedGroups]) {
      if (!group) continue;
      try { process.kill(-group, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') this.emit('diagnostic', { byteCount: 0, code: 'ORPHAN_KILL_FAILED' });
      }
    }
  }

  #rejectPending(error) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.#observeReply(pending, requestId, error.code, 0);
      pending.reject(new RustIpcError(error.code, error.message, { requestId }));
    }
    this.pending.clear();
  }

  #fail(error) {
    this.#rejectPending(error);
    this.emit('failure', error);
  }

  /** Default: metadata-only. Explicit trusted Desktop monitoring may add bounded frames; errors are isolated. */
  #observe(record) {
    if (this.listenerCount('monitor') === 0) return;
    // Public default onMonitorEvent remains metadata-only; only an explicit Desktop mode may see IPC frames.
    const detail = this.detailedMonitoring ? record : Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'frame'));
    try { this.emit('monitor', detail); } catch { /* An observer never reaches the IPC path. */ }
  }

  #observeReply({ op, startedAt }, id, status, bytes, frame) {
    this.#observe({ kind: 'transport.reply', op, id, status, bytes, latencyMs: Date.now() - startedAt, ...(frame ? { frame } : {}) });
  }
}
