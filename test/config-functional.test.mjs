import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateRuntimeConfig } from '../packages/core/src/config.mjs';

function validEnvironment() {
  return {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    OPENAI_REVIEW_APP_ID: '2',
    OPENAI_REVIEW_APP_PRIVATE_KEY: 'openai-app-key',
    CLAUDE_REVIEW_APP_ID: '3',
    CLAUDE_REVIEW_APP_PRIVATE_KEY: 'claude-app-key',
    GATE_APP_ID: '4',
    GATE_APP_PRIVATE_KEY: 'gate-app-key',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    REQUIRED_CI_CONTEXTS: 'ci/verify,ci/security',
    REQUIRED_CI_APP_IDS: 'ci/verify=42,ci/security=43',
  };
}

test('loadConfig derives fresh nested values without mutating its environment input', () => {
  const env = validEnvironment();
  const before = { ...env };

  const first = loadConfig(env);
  const second = loadConfig(env);

  assert.deepEqual(env, before);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.apps, second.apps);
  assert.notStrictEqual(first.review, second.review);
  assert.notStrictEqual(first.review.requiredCiAppIds, second.review.requiredCiAppIds);
  assert.deepEqual(first.review.requiredCiAppIds, {
    'ci/verify': 42,
    'ci/security': 43,
  });
});

test('required CI app identities reject duplicate contexts while constructing the value', () => {
  const env = {
    ...validEnvironment(),
    REQUIRED_CI_APP_IDS: 'ci/verify=42,ci/verify=43',
  };

  assert.throws(() => loadConfig(env), /Duplicate REQUIRED_CI_APP_IDS context: ci\/verify/);
});

test('runtime validation derives missing and identity findings without mutating config', () => {
  const config = loadConfig(validEnvironment());
  const snapshot = JSON.stringify(config, (key, value) => value instanceof RegExp ? value.source : value);

  assert.doesNotThrow(() => validateRuntimeConfig(config));
  assert.equal(
    JSON.stringify(config, (key, value) => value instanceof RegExp ? value.source : value),
    snapshot,
  );

  const duplicate = loadConfig({
    ...validEnvironment(),
    CLAUDE_REVIEW_APP_ID: '2',
  });
  assert.throws(() => validateRuntimeConfig(duplicate), /identities must be distinct/);
});

test('required CI app-id mapping cannot name a context outside the required context set', () => {
  const config = loadConfig({
    ...validEnvironment(),
    REQUIRED_CI_CONTEXTS: 'ci/verify',
    REQUIRED_CI_APP_IDS: 'ci/security=43',
  });

  assert.throws(
    () => validateRuntimeConfig(config),
    /REQUIRED_CI_APP_IDS context is not required by REQUIRED_CI_CONTEXTS: ci\/security/,
  );
});
