import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  validateContractAdmissionPolicy,
} from '../packages/core/src/index.mjs';
import { loadContractProjectionAdmissions } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { contractAdmissionNeedsRefresh } from '../apps/orchestrator/src/reconciler.mjs';
import { makeContractAdmissionFixture } from './helpers/contract-admission-fixture.mjs';

function configFor(fixture) {
  const config = loadConfig({ RECONCILE_INTERVAL_MS: '600000' });
  config.contractAdmission.policy = validateContractAdmissionPolicy(fixture.policy);
  return config;
}

function repository() {
  return {
    full_name: 'O/R',
    name: 'R',
    owner: { login: 'O' },
  };
}

function pullRequest(headSha) {
  return {
    number: 1,
    head: { sha: headSha, repo: { full_name: 'O/R' } },
  };
}

function receipt(fixture, overrides = {}) {
  return {
    owner: 'O',
    repo: 'R',
    prNumber: 1,
    headSha: fixture.headSha,
    projectionKind: 'protobuf',
    result: {
      repository: 'O/R',
      headSha: fixture.headSha,
      projectionKind: 'protobuf',
    },
    producerCheckName: fixture.producerCheckName,
    producerAppId: fixture.producerCheckAppId,
    expiresAt: Date.parse('2026-09-07T06:00:00.000Z'),
    ...overrides,
  };
}

test('reconciler refreshes completed gates with missing, stale, or mismatched receipts', () => {
  const fixture = makeContractAdmissionFixture();
  const config = configFor(fixture);
  const gate = { status: 'completed', conclusion: 'success' };
  const base = {
    config,
    repository: repository(),
    pullRequest: pullRequest(fixture.headSha),
    gate,
    nowMs: Date.parse('2026-09-07T05:00:00.000Z'),
  };

  assert.equal(contractAdmissionNeedsRefresh({
    ...base,
    queue: { getContractAdmissions: () => [] },
  }), true);

  assert.equal(contractAdmissionNeedsRefresh({
    ...base,
    queue: {
      getContractAdmissions: () => [receipt(fixture, {
        expiresAt: Date.parse('2026-09-07T05:05:00.000Z'),
      })],
    },
  }), true);

  assert.equal(contractAdmissionNeedsRefresh({
    ...base,
    queue: {
      getContractAdmissions: () => [receipt(fixture, { producerAppId: 999 })],
    },
  }), true);

  assert.equal(contractAdmissionNeedsRefresh({
    ...base,
    queue: { getContractAdmissions: () => [receipt(fixture)] },
  }), false);
});

test('reconciler leaves an in-progress gate alone and ignores unconfigured repositories', () => {
  const fixture = makeContractAdmissionFixture();
  const config = configFor(fixture);
  const queue = {
    getContractAdmissions() {
      throw new Error('receipts must not be read');
    },
  };
  assert.equal(contractAdmissionNeedsRefresh({
    config,
    queue,
    repository: repository(),
    pullRequest: pullRequest(fixture.headSha),
    gate: { status: 'in_progress' },
  }), false);

  const unconfigured = { ...repository(), full_name: 'Other/R' };
  assert.equal(contractAdmissionNeedsRefresh({
    config,
    queue,
    repository: unconfigured,
    pullRequest: pullRequest(fixture.headSha),
    gate: { status: 'completed' },
  }), false);
});

test('loader rejects a producer check that cannot remain valid through reconciliation', async () => {
  const fixture = makeContractAdmissionFixture();
  fixture.policy.repositories[0].producer.maxCheckAgeSeconds = 600;
  const config = configFor(fixture);
  const queue = new SqliteQueue({ path: ':memory:' });
  let contentRead = false;
  const client = {
    async request(method, path) {
      if (path.includes(`check_name=${encodeURIComponent(fixture.producerCheckName)}`)) {
        return {
          data: {
            check_runs: [{
              id: 42,
              name: fixture.producerCheckName,
              head_sha: fixture.headSha,
              status: 'completed',
              conclusion: 'success',
              completed_at: '2026-09-07T04:51:00.000Z',
              app: { id: fixture.producerCheckAppId },
            }],
          },
        };
      }
      if (method === 'GET' && path.includes('/contents/')) contentRead = true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  try {
    const loaded = await loadContractProjectionAdmissions({
      config,
      client,
      token: 'token',
      queue,
      logger: { warn() {} },
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      pullRequest: pullRequest(fixture.headSha),
      nowMs: Date.parse('2026-09-07T05:00:00.000Z'),
    });
    assert.equal(loaded.admissions[0].findings[0].code, 'producer_check_expiring');
    assert.equal(contentRead, false);
    assert.equal(queue.getContractAdmission({
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      headSha: fixture.headSha,
      projectionKind: 'protobuf',
    })?.expiresAt, Date.parse('2026-09-07T05:01:00.000Z'));
  } finally {
    queue.close();
  }
});
