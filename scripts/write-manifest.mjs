// Writes bin/manifest.json from whatever bin/<target>/ directories exist.
//   --require-all  fail unless every release target is present (release assembly)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINARIES, TARGETS } from './native-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireAll = process.argv.includes('--require-all');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const targets = {};
const missing = [];
for (const [key, spec] of Object.entries(TARGETS)) {
  const dir = join(root, 'bin', key);
  if (!existsSync(dir)) { missing.push(key); continue; }
  const files = BINARIES.map((name) => {
    const fileName = `${name}${spec.exe}`;
    const data = readFileSync(join(dir, fileName));
    return { name: fileName, size: statSync(join(dir, fileName)).size, sha256: createHash('sha256').update(data).digest('hex') };
  });
  const buildFile = join(dir, 'build.json');
  const build = existsSync(buildFile) ? JSON.parse(readFileSync(buildFile, 'utf8')) : null;
  targets[key] = { platform: key.split('-')[0], arch: key.split('-')[1], ...(key.endsWith('-gnu') ? { libc: 'glibc' } : {}), triple: spec.triple, files, build };
}
if (requireAll && missing.length) { console.error(`missing native targets: ${missing.join(', ')}`); process.exit(1); }
const manifest = { schemaVersion: 1, packageName: pkg.name, packageVersion: pkg.version, protocolVersion: 1, targets };
writeFileSync(join(root, 'bin', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, targets: Object.keys(targets), missing }));
