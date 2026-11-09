import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PedelecError } from './errors.ts';

export function storageRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')
    || (process.platform === 'win32' && value.split(/[\\/]/).some((part) => /[. ]$/.test(part)))
  ) {
    throw new PedelecError('INVALID_INPUT', 'runtimeStorageRoot must be a normalized absolute directory');
  }
  return value;
}

function sessionSegment(id: string): string {
  if (/^[a-z0-9_-]{1,128}$/.test(id) && !/^(aux|con|nul|prn|com[0-9]|lpt[0-9])$/.test(id)) return id;
  return '~' + createHash('sha256').update(id).digest('hex');
}

export function sessionStorage(root: string, instance: string, id: string, provider: string) {
  const segment = sessionSegment(id);
  const instanceRoot = join(root, 'instances', instance);
  return {
    segment,
    artifactDirectory: join(instanceRoot, 'artifacts', segment),
    providerStateDirectory: provider === 'ollama' ? join(instanceRoot, 'provider-state', 'ollama', segment) : undefined,
    env: { PEDELEC_STORAGE_ROOT: root, PEDELEC_STORAGE_INSTANCE: instance, PEDELEC_STORAGE_SESSION: segment },
  };
}

type StorageCommand =
  | { action: 'freeze' | 'thaw' | 'seal' }
  | { action: 'prepare' | 'resume' | 'collect' | 'discard-staging'; session: string; ollama: boolean };

function refused(status?: string): PedelecError {
  const code = status === 'busy' ? 'STORAGE_BUSY' : status === 'access-denied' ? 'STORAGE_ACCESS_DENIED'
    : status === 'cross-device' ? 'STORAGE_CROSS_DEVICE' : 'STORAGE_REFUSED';
  return new PedelecError('TRANSPORT_UNAVAILABLE', 'runtime storage ownership or filesystem check refused', code);
}

/**
 * An OS lock owned by the bundled Rust binary, with a pipe tied to this Client's lifetime.
 * Workers and store writers hold independent shared locks, so loss of this pipe cannot authorize GC on live data.
 */
export class StorageKeeper {
  private readonly child;
  private readonly exited: Promise<number | null>;
  private readonly replies: AsyncIterator<string>;
  private tail: Promise<void> = Promise.resolve();
  private dead = false;
  private closePromise?: Promise<void>;
  private reported = false;

  private constructor(binary: string, root: string, instance: string | null) {
    this.child = spawn(binary, ['--storage-keeper', root, instance ?? '-'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('cleanup incomplete')) this.reportIncomplete();
    });
    this.child.on('error', () => { this.dead = true; });
    this.child.stdin.on('error', () => { this.dead = true; });
    this.exited = new Promise((done) => this.child.once('close', (code) => {
      this.dead = true;
      done(code);
    }));
    this.replies = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
    // The Client normally closes explicitly. An abandoned Client must not keep Node alive.
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as typeof stream & { unref?: () => void }).unref?.();
    }
  }

  static async start(binary: string, root: string, instance: string | null): Promise<StorageKeeper> {
    try {
      if (realpathSync(dirname(root)) !== dirname(root)) throw refused();
      const stat = lstatSync(root, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root)) throw refused();
    } catch { throw refused(); }
    const keeper = new StorageKeeper(binary, root, instance);
    try { await keeper.reply(); }
    catch (error) {
      await keeper.close().catch(() => undefined);
      throw error;
    }
    return keeper;
  }

  command(input: StorageCommand): Promise<void> {
    if (this.closePromise) return Promise.reject(refused());
    const command = this.tail.then(async () => {
      if (this.dead) throw refused();
      this.child.stdin.write(JSON.stringify(input) + '\n');
      await this.reply();
    });
    this.tail = command.catch(() => undefined);
    return command;
  }

  private async reply(): Promise<void> {
    // This timer also keeps Node alive while waiting on the otherwise unreferenced keeper.
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.dead = true;
        this.child.kill('SIGKILL');
        reject(refused());
      }, 120_000);
    });
    try {
      const next = await Promise.race([this.replies.next(), timeout]);
      if (next.done || next.value !== 'ok' || this.dead) throw refused(next.value);
    } finally { clearTimeout(timer); }
  }

  reportIncomplete(error?: unknown): void {
    if (this.reported) return;
    this.reported = true;
    const code = error instanceof PedelecError ? error.transportCode : undefined;
    process.stderr.write(`[pedelec] Runtime storage cleanup incomplete (${code ?? 'STORAGE_REFUSED'}). The next owner can retry.\n`);
  }

  close(): Promise<void> {
    this.closePromise ??= this.finish();
    return this.closePromise;
  }

  private async finish(): Promise<void> {
    await this.tail;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
    try {
      if (await this.exited !== 0) throw refused();
    } finally { clearTimeout(timer); }
  }
}
