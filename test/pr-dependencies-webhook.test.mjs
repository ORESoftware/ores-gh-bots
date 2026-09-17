import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';
import {
  dependentGateJobsForWebhook,
  replacePullRequestDependencies,
  SqliteQueue,
} from '../packages/queue/src/index.mjs';

const SHA_A = 'a'.repeat(40);
const SECRET = 'dependency-webhook-test-secret';

function signature(body) {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function config() {
  return {
    server: { webhookPath: '/webhooks/github', bodyLimitBytes: 1024 * 1024 },
    github: { webhookSecret: SECRET, ownerAllowlist: ['Org'], ownerPatterns: [] },
    apps: { gate: { id: '44' } },
  };
}

const logger = { info() {}, warn() {}, error() {} };
const metrics = { increment() {}, render: () => '' };

test('duplicate closed delivery cannot erase dependencies recreated after reopen', async (t) => {
  const queue = new SqliteQueue({ path: ':memory:' });
  const deliveryId = 'replayed-close-delivery';
  queue.acceptWebhook({ deliveryId, event: 'pull_request', action: 'closed', jobs: [] });

  replacePullRequestDependencies(queue, {
    dependentOwner: 'Org',
    dependentRepo: 'a',
    dependentPrNumber: 1,
    dependentHeadSha: SHA_A,
    dependentInstallationId: 10,
    declarations: [{ owner: 'org', repo: 'b', prNumber: 2, expectedVersion: null }],
  });

  const server = createWebhookServer({ config: config(), queue, logger, metrics });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    queue.close();
  });

  const payload = {
    action: 'closed',
    installation: { id: 10 },
    repository: { owner: { login: 'Org' }, name: 'a' },
    pull_request: { number: 1, head: { sha: SHA_A } },
  };
  const body = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature(body),
    },
    body,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: true, jobs: 0 });

  const jobs = dependentGateJobsForWebhook(queue, {
    event: 'pull_request',
    payload: {
      action: 'synchronize',
      repository: { owner: { login: 'Org' }, name: 'b' },
      pull_request: { number: 2 },
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].repo, 'a');
  assert.equal(jobs[0].prNumber, 1);
});
