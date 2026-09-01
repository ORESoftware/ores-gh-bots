import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditConfig } from '@oresoftware/f2e';
import { CLI_FLAGS_PATH, resolveCli } from '../packages/core/src/cli.mjs';

test('repository-root flags-2-env contract audits cleanly', () => {
  assert.deepEqual(auditConfig({ configPath: CLI_FLAGS_PATH }), {
    ok: true,
    errorCount: 0,
    warningCount: 0,
    errors: [],
    warnings: [],
  });
});

test('flags-2-env resolves typed server, exact-review, and canary inputs', () => {
  const server = resolveCli(['node', 'orchestrator', '--port', '9090', '--worker-only'], { env: {} });
  assert.equal(server.values.PORT, 9090);
  assert.equal(server.values.ORES_WORKER_ONLY, true);

  const review = resolveCli([
    'node',
    'runner',
    'review',
    '--owner',
    'ORESoftware',
    '--repo',
    'ores-gh-bots',
    '--pr-number',
    '9',
    '--head-sha',
    'a'.repeat(40),
  ], { env: {} });
  assert.equal(review.command, 'review');
  assert.equal(review.values.REVIEW_PR_NUMBER, 9);
  assert.equal(review.values.REVIEW_REASON, 'one-shot-runner');
  assert.equal(review.values.REVIEW_TYPE, 'review');

  const canary = resolveCli([
    'node',
    'cli',
    'canary',
    'verify',
    '--evidence',
    'result/canary.json',
    '--expected-digest',
    'b'.repeat(64),
  ], { env: {} });
  assert.equal(canary.command, 'canary verify');
  assert.equal(canary.values.ORES_CANARY_EVIDENCE_PATH, 'result/canary.json');
  assert.equal(canary.values.ORES_CANARY_EXPECTED_DIGEST, 'b'.repeat(64));
});

test('flags-2-env rejects unknown, duplicate, and invalid typed options without values in errors', () => {
  for (const argv of [
    ['node', 'runner', 'review', '--unknown', 'sensitive-value'],
    ['node', 'runner', 'review', '--owner', 'one', '--owner', 'two'],
    ['node', 'runner', 'review', '--pr-number', 'not-a-number'],
  ]) {
    assert.throws(() => resolveCli(argv, { env: {} }), /flags-2-env rejected CLI input/u);
  }
  assert.throws(
    () => resolveCli(['node', 'runner', 'review', '--api-key', 'must-not-appear'], { env: {} }),
    (error) => !error.message.includes('must-not-appear'),
  );
});

test('credentials are environment-only and executable boundaries use the canonical parser', async () => {
  const contract = await readFile(CLI_FLAGS_PATH, 'utf8');
  assert.doesNotMatch(contract, /API_KEY|PRIVATE_KEY|WEBHOOK_SECRET|ADMIN_TOKEN/u);
  for (const path of [
    '../apps/orchestrator/src/main.mjs',
    '../apps/runner/src/main.mjs',
    '../apps/cli/src/main.mjs',
    '../scripts/app-manifest.mjs',
  ]) {
    assert.match(await readFile(new URL(path, import.meta.url), 'utf8'), /resolveCli/u);
  }
  const orchestrator = await readFile(new URL('../apps/orchestrator/src/main.mjs', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../apps/runner/src/main.mjs', import.meta.url), 'utf8');
  const fleetCli = await readFile(new URL('../apps/cli/src/main.mjs', import.meta.url), 'utf8');
  assert.match(orchestrator, /if \(cli\.command\) throw/u);
  assert.match(runner, /cli\.command !== 'review'/u);
  assert.match(fleetCli, /results\.some\(\(result\) => result\.error\)\) process\.exitCode = 1/u);
  assert.match(fleetCli, /verifyCanaryEvidence/u);
});
