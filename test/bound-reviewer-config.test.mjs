import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLI_FLAGS_PATH,
  loadConfig,
  resolveCli,
  routeWebhookEvent,
  validateRuntimeConfig,
} from '../packages/core/src/index.mjs';

function validEnvironment(extra = {}) {
  return {
    OWNER_ALLOWLIST: 'ORESoftware',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
    OPENAI_REVIEW_APP_ID: '2',
    OPENAI_REVIEW_APP_PRIVATE_KEY: 'openai-key',
    CLAUDE_REVIEW_APP_ID: '3',
    CLAUDE_REVIEW_APP_PRIVATE_KEY: 'claude-key',
    GATE_APP_ID: '4',
    GATE_APP_PRIVATE_KEY: 'gate-key',
    GHA_MODE: 'disabled',
    ...extra,
  };
}

test('bound reviewer automation is opt-in and requires a user credential when activated', () => {
  const disabled = loadConfig(validEnvironment());
  assert.equal(disabled.reviewer.login, 'the1mills');
  assert.equal(disabled.reviewer.approvalMode, 'off');
  assert.equal(disabled.reviewer.token, null);
  validateRuntimeConfig(disabled, { webhook: false, providers: false });

  const missing = loadConfig(validEnvironment({ REVIEWER_APPROVAL_MODE: 'requested-gate-success' }));
  assert.throws(
    () => validateRuntimeConfig(missing, { webhook: false, providers: false }),
    /GITHUB_REVIEWER_TOKEN/u,
  );

  const active = loadConfig(validEnvironment({
    REVIEWER_APPROVAL_MODE: 'requested-gate-success',
    GITHUB_REVIEWER_TOKEN: 'test-token-value',
    REVIEWER_LOGIN: 'the1mills',
    REVIEWER_MAX_ITEMS: '25',
  }));
  validateRuntimeConfig(active, { webhook: false, providers: false });
  assert.equal(active.reviewer.maxItems, 25);
});

test('invalid reviewer identities and modes fail closed', () => {
  for (const env of [
    { REVIEWER_LOGIN: 'the1mills review-requested:admin' },
    { REVIEWER_LOGIN: 'bad--login' },
    { REVIEWER_APPROVAL_MODE: 'always-approve' },
  ]) {
    const config = loadConfig(validEnvironment(env));
    assert.throws(() => validateRuntimeConfig(config, { webhook: false, providers: false }));
  }
});

test('late review requests queue only an exact-head gate repair', () => {
  const [job] = routeWebhookEvent({
    event: 'pull_request',
    payload: {
      action: 'review_requested',
      installation: { id: 9 },
      repository: { owner: { login: 'ORESoftware' }, name: 'ores-gh-bots' },
      pull_request: { number: 15, head: { sha: 'a'.repeat(40) } },
    },
  });
  assert.deepEqual(job, {
    type: 'gate',
    installationId: 9,
    owner: 'ORESoftware',
    repo: 'ores-gh-bots',
    prNumber: 15,
    headSha: 'a'.repeat(40),
    reason: 'pull_request.review_requested',
    force: true,
  });
});

test('reviewer queue flags are typed while the credential remains environment-only', async () => {
  const parsed = resolveCli([
    'node',
    'cli',
    'reviewer',
    'plan',
    '--reviewer',
    'the1mills',
    '--hints',
    './private/hints.json',
    '--limit',
    '25',
  ], { env: {} });
  assert.equal(parsed.command, 'reviewer plan');
  assert.equal(parsed.values.ORES_REVIEWER_LOGIN, 'the1mills');
  assert.equal(parsed.values.ORES_REVIEWER_HINTS_PATH, './private/hints.json');
  assert.equal(parsed.values.ORES_CLI_LIMIT, 25);

  const contract = await readFile(CLI_FLAGS_PATH, 'utf8');
  assert.doesNotMatch(contract, /GITHUB_REVIEWER_TOKEN/u);
});
