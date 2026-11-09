// Static boundary for the standalone package:
//  1. the SDK imports only node: builtins, its own files and `ajv` (CLI schema validation); nothing Bun-only;
//  2. no Host product identity, Pathcraft name, Cargo target path or environment worker override in SDK/Rust sources;
//  3. the SDK names no Host business identity (workspaceId / taskId).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = path.join(repo, 'src');
const failures = [];
const walk = (dir, test, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(entry.name)) out.push(full);
  }
  return out;
};
const sdkFiles = walk(sdkRoot, (name) => /\.(ts|mts|mjs|js)$/.test(name));
const rustFiles = walk(path.join(repo, 'rust', 'crates'), (name) => /\.(rs|toml)$/.test(name));
const importSpecs = (text) => [
  ...text.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g),
  ...text.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g),
].map((match) => match[1]);
const BUN_GLOBAL = /(?<![\w$.])Bun\s*(?:\.|\?\.|\[)|\btypeof\s+Bun\b|\bglobalThis\s*(?:\.\s*Bun\b|\?\.\s*Bun\b|\[\s*['"`]Bun['"`])/;

for (const file of sdkFiles) {
  const rel = path.relative(repo, file);
  const text = fs.readFileSync(file, 'utf8');
  if (BUN_GLOBAL.test(text)) failures.push(`${rel}: SDK uses the Bun global`);
  for (const spec of importSpecs(text)) {
    if (spec === 'bun' || spec.startsWith('bun:')) { failures.push(`${rel}: SDK imports Bun-only module ${spec}`); continue; }
    if (spec.startsWith('node:')) { if (spec === 'node:sqlite') failures.push(`${rel}: SDK imports node:sqlite`); continue; }
    if (spec === 'ajv' && file === path.join(sdkRoot, 'transport', 'cli-endpoint.ts')) continue;
    if (!spec.startsWith('.')) { failures.push(`${rel}: SDK imports external package ${spec}`); continue; }
    if (!path.resolve(path.dirname(file), spec).startsWith(sdkRoot + path.sep)) failures.push(`${rel}: SDK import escapes the package (${spec})`);
  }
  if (/rust[\\/]target|__\w+_BUNDLE__|process\.env\.\w*WORKER_BIN/.test(text)) failures.push(`${rel}: SDK has a source-tree/env native fallback`);
  if (/\b(?:workspaceId|taskId)\b/.test(text)) failures.push(`${rel}: SDK names a Host business identity`);
}
for (const file of [...sdkFiles, ...rustFiles]) {
  if (/pathcraft/i.test(fs.readFileSync(file, 'utf8'))) failures.push(`${path.relative(repo, file)}: names the Pathcraft Host`);
}
if (failures.length) {
  console.error(JSON.stringify({ ok: false, check: 'pedelec-sdk-boundary', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, check: 'pedelec-sdk-boundary', sdkFiles: sdkFiles.length, rustFiles: rustFiles.length }));
