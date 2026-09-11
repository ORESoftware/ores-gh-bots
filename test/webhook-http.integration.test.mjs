import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Metrics } from '../packages/core/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';

const webhookSecret = 'integration-webhook-secret-at-least-twenty-bytes';

function config() {
  return {
    server: { webhookPath: '/webhooks/github', bodyLimitBytes: 1_024 },
    github: {
      webhookSecret,
      ownerAllowlist: ['ORESoftware'],
      ownerPatterns: [],
    },
    apps: {
      openai: { id: 101 },
      claude: { id: 102 },
      gate: { id: 103 },
    },
    review: { requiredCiContexts: ['ci/verify'] },
  };
}

function pullRequestPayload(overrides = {}) {
  return {
    action: 'opened',
    installation: { id: 77 },
    repository: { name: 'ores-gh-bots', owner: { login: 'ORESoftware' } },
    pull_request: { number: 15, head: { sha: 'a'.repeat(40) } },
    ...overrides,
  };
}

function signature(body) {
  return `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
}

async function startHarness(t, { ready = true } = {}) {
  const queue = new SqliteQueue({ path: ':memory:' });
  const metrics = new Metrics();
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [
    level,
    (message, fields) => logs.push({ level, message, fields }),
  ]));
  const server = createWebhookServer({ config: config(), queue, metrics, logger, readiness: () => ready });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    queue.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, queue, metrics, logs };
}

async function postWebhook(baseUrl, {
  body = JSON.stringify(pullRequestPayload()),
  delivery = 'delivery-1',
  event = 'pull_request',
  webhookSignature = signature(body),
} = {}) {
  return fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': delivery,
      'x-github-event': event,
      'x-hub-signature-256': webhookSignature,
    },
    body,
  });
}

test('HTTP webhook verifies, routes, persists, and de-duplicates a PR delivery', async (t) => {
  const { baseUrl, queue, metrics } = await startHarness(t);

  const first = await postWebhook(baseUrl);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: true, duplicate: false, jobs: 1, inserted: 1 });
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(queue.stats().pending, 1);

  const claimed = queue.claimNext('integration-worker', 30_000);
  assert.equal(claimed.owner, 'ORESoftware');
  assert.equal(claimed.repo, 'ores-gh-bots');
  assert.equal(claimed.prNumber, 15);
  assert.equal(claimed.headSha, 'a'.repeat(40));
  assert.equal(claimed.reason, 'pull_request.opened');

  const duplicate = await postWebhook(baseUrl);
  assert.equal(duplicate.status, 202);
  assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true, jobs: 0 });
  assert.equal(queue.stats().running, 1);

  const rendered = metrics.render();
  assert.match(rendered, /ores_webhooks_total\{event="pull_request",action="opened"\} 1/u);
  assert.match(rendered, /ores_webhooks_duplicate_total\{event="pull_request"\} 1/u);
});

test('HTTP webhook rejects bad signatures, owners, headers, JSON, and oversized bodies without jobs', async (t) => {
  const { baseUrl, queue, logs } = await startHarness(t);

  const invalidSignature = await postWebhook(baseUrl, { delivery: 'bad-signature', webhookSignature: 'sha256=00' });
  assert.equal(invalidSignature.status, 401);
  assert.deepEqual(await invalidSignature.json(), { error: 'invalid_signature' });

  const forbiddenBody = JSON.stringify(pullRequestPayload({
    repository: { name: 'ores-gh-bots', owner: { login: 'untrusted-org' } },
  }));
  const forbidden = await postWebhook(baseUrl, { body: forbiddenBody, delivery: 'bad-owner' });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'owner_not_allowed' });

  const invalidHeaders = await postWebhook(baseUrl, { delivery: 'bad-header', event: 'Pull Request' });
  assert.equal(invalidHeaders.status, 400);
  assert.deepEqual(await invalidHeaders.json(), { error: 'invalid_github_headers' });

  const invalidJsonBody = '{"unterminated":';
  const invalidJson = await postWebhook(baseUrl, { body: invalidJsonBody, delivery: 'bad-json' });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: 'invalid_json' });

  const invalidPayloadBody = '[]';
  const invalidPayload = await postWebhook(baseUrl, { body: invalidPayloadBody, delivery: 'bad-payload' });
  assert.equal(invalidPayload.status, 400);
  assert.deepEqual(await invalidPayload.json(), { error: 'invalid_payload' });

  const oversizedBody = JSON.stringify({ padding: 'x'.repeat(1_024) });
  const oversized = await postWebhook(baseUrl, { body: oversizedBody, delivery: 'too-large' });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request body exceeds configured limit' });

  assert.deepEqual(queue.stats(), {});
  assert.ok(logs.some(({ level, message }) => level === 'warn' && message === 'rejected webhook for non-allowlisted owner'));
});

test('HTTP health, readiness, metrics, ping, and unknown routes have explicit semantics', async (t) => {
  const { baseUrl } = await startHarness(t, { ready: false });

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const readiness = await fetch(`${baseUrl}/readyz`);
  assert.equal(readiness.status, 503);
  assert.deepEqual(await readiness.json(), { ready: false });

  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type'), /text\/plain/u);
  assert.equal(await metrics.text(), '\n');

  const pingBody = JSON.stringify({ zen: 'Keep it logically awesome.' });
  const ping = await postWebhook(baseUrl, { body: pingBody, delivery: 'ping-1', event: 'ping' });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, zen: 'Keep it logically awesome.' });

  const missing = await fetch(`${baseUrl}/not-found`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });
});
