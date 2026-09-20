import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ownerIsAllowed } from '../packages/core/src/index.mjs';

test('owner allowlist rejects unrelated organizations by default', () => {
  const config = loadConfig({ OWNER_ALLOWLIST: 'ORESoftware', OWNER_PATTERNS: '.*-test$' });
  assert.equal(ownerIsAllowed(config, 'ORESoftware'), true);
  assert.equal(ownerIsAllowed(config, 'fiducia-cloud-test'), true);
  assert.equal(ownerIsAllowed(config, 'random-org'), false);
  assert.equal(ownerIsAllowed(loadConfig({}), 'ORESoftware'), false);
});
