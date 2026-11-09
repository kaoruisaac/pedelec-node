import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTarget, resolveNativeBundle, validateExplicitWorker, PACKAGE_ROOT } from '../src/transport/native-bundle.mjs';
import { createPedelecRuntime, nativeRuntimeInfo } from '../src/index.ts';

describe('native bundle dispatch', () => {
  it.each([
    ['darwin', 'arm64', null, 'darwin-arm64'],
    ['win32', 'x64', null, 'win32-x64'],
    ['linux', 'x64', '2.36', 'linux-x64-gnu'],
  ])('maps %s/%s to a shipped target', (platform, arch, glibc, key) => {
    expect(nativeTarget(platform as NodeJS.Platform, arch, glibc)).toBe(key);
  });

  it.each([
    ['linux', 'x64', null],
    ['linux', 'arm64', '2.36'],
    ['darwin', 'x64', null],
    ['win32', 'arm64', null],
    ['freebsd', 'x64', null],
  ])('refuses %s/%s (glibc %s) as unsupported', (platform, arch, glibc) => {
    expect(() => nativeTarget(platform as NodeJS.Platform, arch, glibc)).toThrow(expect.objectContaining({ code: 'NATIVE_UNSUPPORTED_PLATFORM' }));
  });

  it('verifies the staged bundle and exposes no executable path publicly', () => {
    const info = nativeRuntimeInfo();
    expect(info.version).toBe(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
    expect(Object.values(info).join(' ')).not.toContain('pedelec-ipc-worker');
  });

  it('refuses a target the manifest does not list', () => {
    const root = mkdtempSync(join(tmpdir(), 'pedelec-bundle-'));
    try {
      cpSync(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'));
      cpSync(join(PACKAGE_ROOT, 'bin', 'manifest.json'), join(root, 'bin', 'manifest.json'), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(root, 'bin', 'manifest.json'), 'utf8'));
      manifest.targets = {};
      writeFileSync(join(root, 'bin', 'manifest.json'), JSON.stringify(manifest));
      expect(() => resolveNativeBundle({ root, target: 'linux-x64-gnu' })).toThrow(expect.objectContaining({ code: 'NATIVE_BINARY_MISSING' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts only an absolute regular file as an explicit worker', async () => {
    expect(() => validateExplicitWorker('relative/worker')).toThrow(expect.objectContaining({ code: 'NATIVE_BINARY_INVALID' }));
    expect(() => validateExplicitWorker(join(tmpdir(), 'missing-pedelec-worker'))).toThrow(expect.objectContaining({ code: 'NATIVE_BINARY_MISSING' }));
    await expect(createPedelecRuntime({ rustIpc: { binaryPath: tmpdir() } })).rejects.toMatchObject({ code: 'TRANSPORT_UNAVAILABLE', transportCode: 'NATIVE_BINARY_INVALID' });
  });
});
