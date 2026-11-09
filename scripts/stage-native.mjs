// Copies freshly built Cargo binaries into bin/<target>/ and rewrites bin/manifest.json.
//   node scripts/stage-native.mjs [--profile release|debug] [--target darwin-arm64|win32-x64|linux-x64-gnu] [--triple-dir]
// --triple-dir reads rust/target/<triple>/<profile>/ (cross builds) instead of rust/target/<profile>/.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BINARIES, TARGETS, hostTarget } from './native-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { profile: { type: 'string', default: 'release' }, target: { type: 'string', default: hostTarget() }, 'triple-dir': { type: 'boolean', default: false } } });
const spec = TARGETS[values.target];
if (!spec) { console.error(`unsupported target ${values.target}`); process.exit(1); }
const from = values['triple-dir'] ? join(root, 'rust', 'target', spec.triple, values.profile) : join(root, 'rust', 'target', values.profile);
const out = join(root, 'bin', values.target);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of BINARIES) {
  const file = `${name}${spec.exe}`;
  const source = join(from, file);
  if (!existsSync(source)) { console.error(`missing ${source}; build it first`); process.exit(1); }
  copyFileSync(source, join(out, file));
  if (!spec.exe) chmodSync(join(out, file), 0o755);
}
const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout?.trim() || null;
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || null;
writeFileSync(join(out, 'build.json'), JSON.stringify({ target: values.target, triple: spec.triple, profile: values.profile, rustc, commit }, null, 2) + '\n');
const manifest = spawnSync(process.execPath, [join(root, 'scripts', 'write-manifest.mjs')], { stdio: 'inherit' });
process.exit(manifest.status ?? 1);
