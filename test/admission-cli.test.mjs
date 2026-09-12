import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/classify-workflow-evidence.mjs', import.meta.url));

async function withFixture(value, run) {
  const directory = await mkdtemp(join(tmpdir(), 'ores-ci-evidence-'));
  const path = join(directory, 'evidence.json');
  await writeFile(path, JSON.stringify(value), 'utf8');
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('CLI emits a machine-readable admission classification without echoing input fields', async () => {
  await withFixture({
    workflow_run: { status: 'completed', conclusion: 'action_required' },
    jobs: [],
    untrusted_payload: 'must-not-be-echoed',
  }, (path) => {
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.outcome, 'admission_failure');
    assert.equal(parsed.product_failure, false);
    assert.doesNotMatch(result.stdout, /must-not-be-echoed/);
  });
});

test('CLI fails closed on malformed evidence', async () => {
  await withFixture({ jobs: {} }, (path) => {
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /jobs must be an array/);
  });
});

test('CLI requires exactly one evidence path', () => {
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);

  const extra = spawnSync(process.execPath, [script, 'a.json', 'b.json'], { encoding: 'utf8' });
  assert.equal(extra.status, 2);
});
