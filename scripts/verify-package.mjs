// Release gate for the single npm artifact. Checks dist/, LICENSE/notices and every native file against the manifest.
//   --prepack            run as npm prepack (requires all three targets unless PEDELEC_PACK_PARTIAL=1)
//   --tarball <file>     also verify a packed tarball's file list (one package, no stray files)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BINARIES, TARGETS } from './native-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { prepack: { type: 'boolean', default: false }, tarball: { type: 'string' } } });
const partial = process.env.PEDELEC_PACK_PARTIAL === '1';
const failures = [];
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/transport/native-bundle.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'bin/manifest.json']) {
  if (!existsSync(join(root, file))) failures.push(`missing ${file}`);
}
let manifest = { targets: {} };
try { manifest = JSON.parse(readFileSync(join(root, 'bin/manifest.json'), 'utf8')); } catch { /* reported above */ }
if (manifest.packageName !== pkg.name || manifest.packageVersion !== pkg.version) failures.push('manifest package identity does not match package.json');
for (const [key, spec] of Object.entries(TARGETS)) {
  const entry = manifest.targets?.[key];
  if (!entry) { if (!partial) failures.push(`manifest lacks ${key}`); continue; }
  for (const name of BINARIES) {
    const fileName = `${name}${spec.exe}`;
    const record = entry.files.find((f) => f.name === fileName);
    const file = join(root, 'bin', key, fileName);
    if (!record || !existsSync(file)) { failures.push(`missing ${key}/${fileName}`); continue; }
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (sha !== record.sha256 || statSync(file).size !== record.size) failures.push(`${key}/${fileName} does not match manifest`);
    if (!spec.exe && (statSync(file).mode & 0o111) === 0) failures.push(`${key}/${fileName} is not executable`);
  }
}
let tarball;
if (values.tarball) {
  const list = spawnSync('tar', ['-tzf', values.tarball], { encoding: 'utf8' });
  const files = list.stdout.trim().split('\n');
  const allowed = /^package\/(package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|dist\/.+\.(js|mjs|d\.ts|d\.mts)|bin\/manifest\.json|bin\/(darwin-arm64|win32-x64|linux-x64-gnu)\/(pedelec-(ipc-worker|agent|cli)(\.exe)?|build\.json))$/;
  for (const file of files) if (!allowed.test(file)) failures.push(`unexpected file in tarball: ${file}`);
  if (files.some((f) => f.endsWith('.map'))) failures.push('tarball contains source maps');
  tarball = { files: files.length, bytes: statSync(values.tarball).size, sha256: createHash('sha256').update(readFileSync(values.tarball)).digest('hex') };
  if (tarball.bytes > 200 * 1024 * 1024) failures.push('tarball exceeds 200 MiB');
}
if (failures.length) { console.error(JSON.stringify({ ok: false, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ok: true, version: pkg.version, targets: Object.keys(manifest.targets), ...(tarball ? { tarball } : {}) }));
