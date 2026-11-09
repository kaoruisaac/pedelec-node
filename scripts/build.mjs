// Builds dist/: tsc emits ESM JavaScript + .d.ts; the hand-written .mjs transport modules and their .d.mts are copied.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
for (const file of walk(src).filter((f) => f.endsWith('.mjs') || f.endsWith('.d.mts'))) {
  const out = join(dist, relative(src, file));
  mkdirSync(dirname(out), { recursive: true });
  cpSync(file, out);
}
console.log(JSON.stringify({ ok: true, dist: relative(root, dist), files: walk(dist).length }));
