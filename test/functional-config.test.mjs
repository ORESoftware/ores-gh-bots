import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConfig,
  runtimeConfigError,
  validateRuntimeConfig,
} from '../packages/core/src/index.mjs';

const distinctEnvironment = {
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
  GITHUB_WEBHOOK_SECRET: 'webhook-secret',
  OPENAI_API_KEY: 'openai-key',
  ANTHROPIC_API_KEY: 'anthropic-key',
  OPENAI_REVIEW_APP_ID: '2',
  OPENAI_REVIEW_APP_PRIVATE_KEY: 'openai-app-key',
  CLAUDE_REVIEW_APP_ID: '3',
  CLAUDE_REVIEW_APP_PRIVATE_KEY: 'claude-app-key',
  GATE_APP_ID: '4',
  GATE_APP_PRIVATE_KEY: 'gate-app-key',
  REQUIRED_CI_CONTEXTS: 'ci/verify',
  REQUIRED_CI_APP_IDS: 'ci/verify=42',
};

test('runtimeConfigError returns validation failures without mutating config', () => {
  const config = loadConfig({});
  const before = structuredClone(config);

  const error = runtimeConfigError(config);

  assert.match(error, /GITHUB_APP_ID/);
  assert.deepEqual(config, before);
});

test('pure validation and throwing compatibility shell agree', () => {
  const valid = loadConfig(distinctEnvironment);
  assert.equal(runtimeConfigError(valid), null);
  assert.doesNotThrow(() => validateRuntimeConfig(valid));

  const duplicate = loadConfig({
    ...distinctEnvironment,
    CLAUDE_REVIEW_APP_ID: '2',
  });
  const error = runtimeConfigError(duplicate);
  assert.match(error, /identities must be distinct/);
  assert.throws(() => validateRuntimeConfig(duplicate), /identities must be distinct/);
});

test('required CI app-id parsing returns a fresh object per config', () => {
  const first = loadConfig(distinctEnvironment);
  const second = loadConfig(distinctEnvironment);

  assert.notEqual(first.review.requiredCiAppIds, second.review.requiredCiAppIds);
  assert.deepEqual(first.review.requiredCiAppIds, { 'ci/verify': 42 });
  assert.deepEqual(second.review.requiredCiAppIds, { 'ci/verify': 42 });
});
