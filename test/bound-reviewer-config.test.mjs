import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateRuntimeConfig } from '../packages/core/src/index.mjs';

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
    ...extra,
  };
}

test('bound reviewer automation is disabled by default', () => {
  const config = loadConfig(validEnvironment());
  assert.deepEqual(config.reviewer, {
    login: 'the1mills',
    token: null,
    approvalMode: 'off',
    maxItems: 100,
  });
  assert.doesNotThrow(() => validateRuntimeConfig(config, { webhook: false, providers: false }));
});

test('activating bound reviewer automation requires its user credential', () => {
  const missing = loadConfig(validEnvironment({
    REVIEWER_APPROVAL_MODE: 'requested-gate-success',
  }));
  assert.throws(
    () => validateRuntimeConfig(missing, { webhook: false, providers: false }),
    /GITHUB_REVIEWER_TOKEN/u,
  );

  const active = loadConfig(validEnvironment({
    REVIEWER_APPROVAL_MODE: 'requested-gate-success',
    GITHUB_REVIEWER_TOKEN: 'test-token',
    REVIEWER_LOGIN: 'the1mills',
    REVIEWER_MAX_ITEMS: '25',
  }));
  assert.doesNotThrow(() => validateRuntimeConfig(active, { webhook: false, providers: false }));
  assert.equal(active.reviewer.maxItems, 25);
});

test('invalid reviewer activation modes and logins fail closed', () => {
  for (const extra of [
    { REVIEWER_APPROVAL_MODE: 'always-approve' },
    { REVIEWER_LOGIN: 'bad--login' },
    { REVIEWER_LOGIN: 'bad-' },
    { REVIEWER_LOGIN: 'name review-requested:admin' },
    { REVIEWER_LOGIN: 'x'.repeat(40) },
  ]) {
    const config = loadConfig(validEnvironment(extra));
    assert.throws(
      () => validateRuntimeConfig(config, { webhook: false, providers: false }),
    );
  }
});

test('reviewer queue bounds use the strict integer parser', () => {
  assert.equal(loadConfig(validEnvironment({ REVIEWER_MAX_ITEMS: ' 25 ' })).reviewer.maxItems, 25);
  for (const value of ['0', '101', '25items', '1e2']) {
    assert.throws(() => loadConfig(validEnvironment({ REVIEWER_MAX_ITEMS: value })), /Invalid integer value/u);
  }
});
