import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  validateContractAdmissionPolicy,
} from '../packages/core/src/index.mjs';
import { loadContractProjectionAdmissions } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { makeContractAdmissionFixture } from './helpers/contract-admission-fixture.mjs';

function configFor(fixture) {
  const config = loadConfig({});
  config.contractAdmission.policy = validateContractAdmissionPolicy(fixture.policy);
  return config;
}

test('statusless GitHub transport failure is retried instead of persisted as semantic rejection', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
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
              completed_at: '2026-09-07T04:30:00.000Z',
              app: { id: fixture.producerCheckAppId },
            }],
          },
        };
      }
      if (method === 'GET' && path.includes('/contents/')) {
        throw new TypeError('fetch failed');
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  try {
    await assert.rejects(
      () => loadContractProjectionAdmissions({
        config: configFor(fixture),
        client,
        token: 'token',
        queue,
        logger: { warn() {} },
        owner: 'O',
        repo: 'R',
        prNumber: 1,
        pullRequest: {
          head: {
            sha: fixture.headSha,
            repo: { full_name: 'O/R' },
          },
        },
        nowMs: Date.parse('2026-09-07T05:00:00.000Z'),
      }),
      /fetch failed/u,
    );
    assert.equal(queue.getContractAdmissions({
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      headSha: fixture.headSha,
    }).length, 0);
  } finally {
    queue.close();
  }
});
