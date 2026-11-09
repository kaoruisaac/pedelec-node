import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('SDK-09 static boundary', () => {
  it('keeps the SDK free of Host products, source-tree fallbacks and foreign packages', () => {
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'scripts/check-pedelec-sdk-boundary.mjs')], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });
});
