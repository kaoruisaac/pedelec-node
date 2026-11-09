import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SDK-private: locates the native executables shipped inside this one npm package.
 *
 * Layout (package root): `bin/manifest.json` + `bin/<target>/{pedelec-ipc-worker,pedelec-agent,pedelec-cli}[.exe]`.
 * Before the first spawn the manifest is checked against package.json, the IPC protocol and every file's size and
 * SHA-256. There is no fallback: a missing, mismatched or symlinked binary fails closed with a readable error, and
 * a Cargo `target/` directory, another repository or the PATH are never searched.
 */

export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_BINARIES = Object.freeze(['pedelec-ipc-worker', 'pedelec-agent', 'pedelec-cli']);
export const SUPPORTED_TARGETS = Object.freeze(['darwin-arm64', 'win32-x64', 'linux-x64-gnu']);

export class NativeBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeBundleError';
    this.code = code;
  }
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** `src/transport` in the repository and `dist/transport` in the package are both two levels below the root. */
export const PACKAGE_ROOT = path.resolve(moduleDir, '..', '..');

/** glibc version reported by Node, or null on musl / non-Linux. */
function glibcVersion() {
  try {
    const header = process.report?.getReport?.().header;
    return typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : null;
  } catch {
    return null;
  }
}

/** The bundle key for this process, or throws for a platform this release does not ship. */
export function nativeTarget(platform = process.platform, arch = process.arch, glibc = platform === 'linux' ? glibcVersion() : null) {
  let key;
  if (platform === 'linux') key = glibc ? `linux-${arch}-gnu` : `linux-${arch}-musl`;
  else key = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.includes(key)) {
    throw new NativeBundleError('NATIVE_UNSUPPORTED_PLATFORM',
      `@kaoruisaac/pedelec-node ships native runtimes for ${SUPPORTED_TARGETS.join(', ')}; this host is ${key}`);
  }
  return key;
}

function readJson(file, missingCode, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch {
    throw new NativeBundleError(missingCode, `${label} is missing from the installed package`);
  }
  try { return JSON.parse(text); } catch {
    throw new NativeBundleError('NATIVE_MANIFEST_MISMATCH', `${label} is not valid JSON`);
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const verified = new Map();

/**
 * Resolves and verifies this platform's bundle once per process.
 * @returns {{ target: string, directory: string, worker: string, agent: string, cli: string, version: string }}
 */
export function resolveNativeBundle({ root = PACKAGE_ROOT, target = undefined } = {}) {
  const key = target ?? nativeTarget();
  const cacheKey = `${root}\u0000${key}`;
  const cached = verified.get(cacheKey);
  if (cached) return cached;

  const realRoot = realpathSync(root);
  const pkg = readJson(path.join(realRoot, 'package.json'), 'NATIVE_MANIFEST_MISSING', 'package.json');
  const manifest = readJson(path.join(realRoot, 'bin', 'manifest.json'), 'NATIVE_MANIFEST_MISSING', 'Native manifest (bin/manifest.json)');
  if (manifest.packageName !== pkg.name || manifest.packageVersion !== pkg.version) {
    throw new NativeBundleError('NATIVE_MANIFEST_MISMATCH',
      `Native manifest is for ${manifest.packageName}@${manifest.packageVersion}, but the SDK is ${pkg.name}@${pkg.version}`);
  }
  if (manifest.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new NativeBundleError('NATIVE_MANIFEST_MISMATCH',
      `Native manifest speaks IPC protocol ${manifest.protocolVersion}; the SDK requires ${NATIVE_PROTOCOL_VERSION}`);
  }
  const entry = manifest.targets?.[key];
  if (!entry || !Array.isArray(entry.files)) {
    throw new NativeBundleError('NATIVE_BINARY_MISSING', `This package build does not contain the ${key} native runtime`);
  }
  const directory = path.join(realRoot, 'bin', key);
  const extension = key.startsWith('win32-') ? '.exe' : '';
  const resolved = {};
  for (const name of NATIVE_BINARIES) {
    const fileName = `${name}${extension}`;
    const record = entry.files.find((file) => file.name === fileName);
    if (!record) throw new NativeBundleError('NATIVE_MANIFEST_MISMATCH', `Native manifest has no ${key}/${fileName} entry`);
    const file = path.join(directory, fileName);
    let stat;
    try { stat = lstatSync(file); } catch {
      throw new NativeBundleError('NATIVE_BINARY_MISSING', `Native runtime ${key}/${fileName} is missing from the installed package`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new NativeBundleError('NATIVE_BINARY_INVALID', `Native runtime ${key}/${fileName} is not a regular file`);
    }
    if (!extension && (stat.mode & 0o111) === 0) {
      throw new NativeBundleError('NATIVE_BINARY_INVALID', `Native runtime ${key}/${fileName} is not executable`);
    }
    if (stat.size !== record.size || sha256(file) !== record.sha256) {
      throw new NativeBundleError('NATIVE_MANIFEST_MISMATCH', `Native runtime ${key}/${fileName} does not match the package manifest`);
    }
    resolved[name] = file;
  }
  const bundle = Object.freeze({
    target: key,
    directory,
    worker: resolved['pedelec-ipc-worker'],
    agent: resolved['pedelec-agent'],
    cli: resolved['pedelec-cli'],
    version: pkg.version,
  });
  verified.set(cacheKey, bundle);
  return bundle;
}

/**
 * A Host-supplied worker path (`rustIpc.binaryPath`) is trusted configuration, but it must still be an absolute
 * regular file, with `pedelec-cli` beside it. Nothing is inferred from environment variables.
 */
export function validateExplicitWorker(binaryPath) {
  if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) {
    throw new NativeBundleError('NATIVE_BINARY_INVALID', 'rustIpc.binaryPath must be an absolute path');
  }
  let stat;
  try { stat = lstatSync(binaryPath); } catch {
    throw new NativeBundleError('NATIVE_BINARY_MISSING', 'rustIpc.binaryPath does not exist');
  }
  if (!stat.isFile()) throw new NativeBundleError('NATIVE_BINARY_INVALID', 'rustIpc.binaryPath is not a regular file');
  return binaryPath;
}
