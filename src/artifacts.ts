import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { PedelecArtifact, PedelecArtifactKind } from './types.ts';

/** Same bound as the Worker's `MAX_ASSET_UPLOAD_BYTES`. */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_NAME_CHARS = 128;
const MAX_MIME_BYTES = 128;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPTIONAL_ID_BYTES = 512;

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function optionalId(value: unknown): string | undefined {
  return text(value) && Buffer.byteLength(value) <= OPTIONAL_ID_BYTES && !/[\u0000-\u001f]/.test(value) ? value : undefined;
}

function safeFilename(value: unknown): string {
  const leaf = typeof value === 'string' ? value.split(/[\\/]/).at(-1) ?? '' : '';
  const cleaned = leaf.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, MAX_NAME_CHARS).replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'artifact';
}

function kindOf(mimeType: string): PedelecArtifactKind {
  const family = mimeType.slice(0, mimeType.indexOf('/'));
  return family === 'image' || family === 'audio' || family === 'video' ? family : 'file';
}

function normalizedMime(value: unknown): string | null {
  if (!text(value) || Buffer.byteLength(value) > MAX_MIME_BYTES) return null;
  const mime = value.split(';', 1)[0]!.trim().toLowerCase();
  return MIME.test(mime) ? mime : null;
}

async function sha256Of(path: string): Promise<string> {
  // Read through the handle, so a swap after lstat cannot be followed to another file.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Lands Provider output in this SDK Session's private artifact directory. The Worker only copies raw bytes
 * into this Session's staging folder, so the SDK decides what a file is called, where it ends
 * up and whether it counts. Paths and names reported by the Worker are never trusted as such.
 */
export class ArtifactStore {
  readonly stagingDirectory: string;
  private readonly directory: string;
  private readonly cleanupStaging: () => Promise<void>;

  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;

  constructor(directory: string, segment: string, cleanupStaging: () => Promise<void>) {
    this.directory = directory;
    this.cleanupStaging = cleanupStaging;
    this.stagingDirectory = join(directory, '.pedelec-staging', segment);
  }

  /** The canonical staged path, only for a direct child of this Session's staging folder. */
  private async owned(stagedPath: unknown): Promise<string | null> {
    if (!text(stagedPath) || !isAbsolute(stagedPath) || stagedPath.includes('\0')) return null;
    try {
      const canonical = await realpath(this.stagingDirectory);
      return canonical === this.stagingDirectory && dirname(stagedPath) === canonical ? stagedPath : null;
    }
    catch { return null; }
  }

  /** Validates one `artifact` frame and renames its file into place. Throws when it does not qualify. */
  land(data: Readonly<Record<string, unknown>>): Promise<PedelecArtifact> {
    if (!this.accepting) return Promise.reject(new Error('ARTIFACT_STORAGE_CLOSED'));
    return this.track(this.landOwned(data));
  }

  private async landOwned(data: Readonly<Record<string, unknown>>): Promise<PedelecArtifact> {
    const staged = await this.owned(data.stagedPath);
    const mimeType = normalizedMime(data.mimeType);
    const { bytes, sha256, source } = data;
    if (!staged || !mimeType || !text(source) || !SOURCE.test(source) || !text(sha256) || !SHA256.test(sha256)
      || !Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > MAX_ARTIFACT_BYTES) {
      throw new Error('ARTIFACT_INVALID');
    }
    const stat = await lstat(staged);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes) throw new Error('ARTIFACT_INVALID');
    if (await sha256Of(staged) !== sha256) throw new Error('ARTIFACT_INVALID');
    const id = randomUUID();
    const name = safeFilename(data.filename);
    const path = join(this.directory, `${id}-${name}`);
    // Same volume by construction, so this is atomic; a landed file is never replaced.
    await lstat(path).then(() => { throw new Error('ARTIFACT_EXISTS'); }, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const current = await lstat(staged);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev
      || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || !await this.owned(staged)) {
      throw new Error('ARTIFACT_STORAGE_CHANGED');
    }
    await rename(staged, path);
    const providerArtifactId = optionalId(data.providerArtifactId);
    const toolCallId = optionalId(data.toolCallId);
    return Object.freeze({
      id, name, path, kind: kindOf(mimeType), source, mimeType, sizeBytes: stat.size, sha256,
      ...(providerArtifactId === undefined ? {} : { providerArtifactId }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }

  /** Drops a staged file that will not land. A path outside this Session's staging is left alone. */
  discard(stagedPath: unknown): Promise<void> {
    return this.accepting ? this.track(this.discardOwned(stagedPath)) : Promise.resolve();
  }

  private async discardOwned(stagedPath: unknown): Promise<void> {
    const staged = await this.owned(stagedPath);
    if (staged) await rm(staged, { force: true }).catch(() => undefined);
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    try { return await work; }
    finally { this.pending.delete(work); }
  }

  /** Clears unfinished staging only. Landed files stay, whatever became of their Turn. */
  async cleanup(workerStopped = true): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(this.pending);
    if (workerStopped) await this.cleanupStaging();
  }
}
