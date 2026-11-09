// Keep the single SDK/Rust release version in sync without network access or a build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [next, ...extra] = process.argv.slice(2);
if (extra.length || !next || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(next)) {
  console.error('Usage: npm run version <semver>  (example: npm run version 0.0.1)');
  process.exit(1);
}
const path = (file) => join(root, file);
const read = (file) => readFileSync(path(file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
if (pkg.name !== '@kaoruisaac/pedelec-node' || lock.name !== pkg.name || lock.packages?.['']?.name !== pkg.name ||
    pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
  throw new Error('SDK package and lockfile versions are inconsistent; fix them before bumping.');
}
const old = pkg.version;
const cargoToml = read('rust/Cargo.toml');
const workspaceLine = `version = "${old}"`;
const workspace = cargoToml.match(/\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/);
if (!workspace || !workspace[1].includes(workspaceLine)) throw new Error('Rust workspace version does not match SDK.');
const cargoLock = read('rust/Cargo.lock');
const crates = ['pedelec-agent', 'pedelec-cli', 'pedelec-core', 'pedelec-ipc-worker', 'pedelec-runtime', 'pedelec-shared'];
let nextLock = cargoLock;
for (const name of crates) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = ")\\d+\\.\\d+\\.\\d+(?:-[^"]+)?(")`, 'g');
  const matches = [...nextLock.matchAll(re)];
  if (matches.length !== 1 || !matches[0][0].includes(`version = "${old}"`)) {
    throw new Error(`Cargo.lock version mismatch for ${name}`);
  }
  nextLock = nextLock.replace(re, (_, start, end) => start + next + end);
}

if (next === old) {
  console.log(`Version is already ${next}; nothing changed.`);
  process.exit(0);
}
pkg.version = next;
lock.version = next;
lock.packages[''].version = next;
const nextToml = cargoToml.replace(
  /^(\[workspace\.package\]\n(?:[^\[]|\[(?!))*)/m,
  (section) => section.replace(`version = "${old}"`, `version = "${next}"`),
);
if (nextToml === cargoToml) throw new Error('Unable to update workspace.package version.');
// All checks above run before writing; Cargo.lock stays usable with --locked.
for (const [file, content] of [
  ['package.json', JSON.stringify(pkg, null, 2) + '\n'],
  ['package-lock.json', JSON.stringify(lock, null, 2) + '\n'],
  ['rust/Cargo.toml', nextToml],
  ['rust/Cargo.lock', nextLock],
]) writeFileSync(path(file), content);
console.log(`Updated SDK and six Rust crates: ${old} -> ${next}`);
console.log('Native binaries / bin/manifest.json are NOT rebuilt. Rebuild and restage all platforms,');
console.log('regenerate the manifest, and rerun release verification before publishing.');
