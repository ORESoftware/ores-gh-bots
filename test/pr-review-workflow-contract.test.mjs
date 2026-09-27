import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/pr-review.yml', import.meta.url);

test('trusted PR review builds flags2env before running repository checks', async () => {
  const source = await readFile(WORKFLOW, 'utf8');
  const install = source.indexOf('run: npm ci --ignore-scripts');
  const build = source.indexOf('run: npm run build:flags2env');
  const check = source.indexOf('run: npm run check');

  assert.notEqual(install, -1, 'trusted install step must remain explicit');
  assert.notEqual(build, -1, 'native flags2env build step must remain explicit');
  assert.notEqual(check, -1, 'trusted validation step must remain explicit');
  assert.ok(install < build, 'flags2env must be built only after exact lockfile installation');
  assert.ok(build < check, 'native boundary must exist before tests import @oresoftware/f2e');
});
