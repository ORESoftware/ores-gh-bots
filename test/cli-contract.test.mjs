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

test('flags-2-env resolves typed server and exact-review inputs', () => {
  const server = resolveCli(['node', 'orchestrator', '--port', '9090', '--worker-only'], { env: {} });
  assert.equal(server.command, '');
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
});

test('current admin commands stay represented by the root contract', () => {
  const plan = resolveCli(['node', 'cli', 'rulesets', 'plan'], { env: {} });
  assert.equal(plan.command, 'rulesets plan');
  assert.equal(plan.values.ORES_CLI_ENFORCEMENT, 'evaluate');
  assert.equal(plan.values.ORES_CLI_BRANCH_MODE, 'protected');

  const reviewer = resolveCli(['node', 'cli', 'reviewer', 'plan', '--reviewer', 'the1mills', '--limit', '17'], { env: {} });
  assert.equal(reviewer.command, 'reviewer plan');
  assert.equal(reviewer.values.ORES_REVIEWER_LOGIN, 'the1mills');
  assert.equal(reviewer.values.ORES_REVIEWER_QUEUE_LIMIT, 17);

  const canary = resolveCli(['node', 'cli', 'canary', 'verify', '--evidence', 'canary.json', '--expected-digest', 'a'.repeat(64)], { env: {} });
  assert.equal(canary.command, 'canary verify');
  assert.equal(canary.values.ORES_CANARY_EVIDENCE_PATH, 'canary.json');
  assert.equal(canary.values.ORES_CANARY_EXPECTED_DIGEST, 'a'.repeat(64));
});

test('flags-2-env rejects unknown, duplicate, and invalid typed options without echoing values', () => {
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

test('credentials remain environment-only and active executable boundaries use the canonical parser', async () => {
  const contract = await readFile(CLI_FLAGS_PATH, 'utf8');
  assert.doesNotMatch(contract, /API_KEY|PRIVATE_KEY|WEBHOOK_SECRET|ADMIN_TOKEN|REVIEWER_TOKEN/u);
  for (const path of [
    '../apps/orchestrator/src/main.mjs',
    '../apps/runner/src/main.mjs',
    '../apps/cli/src/main.mjs',
  ]) {
    assert.match(await readFile(new URL(path, import.meta.url), 'utf8'), /resolveCli/u);
  }
  const orchestrator = await readFile(new URL('../apps/orchestrator/src/main.mjs', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../apps/runner/src/main.mjs', import.meta.url), 'utf8');
  assert.match(orchestrator, /if \(cli\.command\) throw/u);
  assert.match(runner, /cli\.command !== 'review'/u);
});
