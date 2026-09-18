import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { loadConfig, Metrics } from '../packages/core/src/index.mjs';
import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';

const secret = 'den-3793-webhook-secret';

function dependencies() {
  return {
    queue: {},
    logger: { info() {}, warn() {}, error() {} },
    metrics: new Metrics(),
  };
}

function config(overrides = {}) {
  return loadConfig({
    OWNER_ALLOWLIST: 'ORESoftware',
    GITHUB_WEBHOOK_SECRET: secret,
    ...overrides,
  });
}

async function start(t, overrides = {}, readiness = () => true) {
  const server = createWebhookServer({
    config: config(overrides),
    ...dependencies(),
    readiness,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function signature(body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('HTTP ingress integer configuration rejects partial numeric syntax', () => {
  for (const value of ['8080ms', '1e3', '0x10', '12.5', '--1']) {
    assert.throws(() => loadConfig({ PORT: value }), /Invalid integer value/u);
  }
  assert.equal(loadConfig({ PORT: ' 8081 ' }).server.port, 8081);
  assert.equal(loadConfig({ PORT: '+8082' }).server.port, 8082);
});

test('HTTP ingress budgets are finite, bounded, and internally consistent', () => {
  assert.deepEqual(loadConfig({}).server, {
    port: 8080,
    webhookPath: '/webhooks/github',
    bodyLimitBytes: 2_000_000,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    keepAliveTimeoutMs: 5_000,
    maxHeaderBytes: 16_384,
    maxHeadersCount: 64,
    maxRequestsPerSocket: 100,
  });
  assert.throws(
    () => config({ HTTP_HEADERS_TIMEOUT_MS: '31000', HTTP_REQUEST_TIMEOUT_MS: '30000' }),
    /must not exceed/u,
  );

  const invalid = [
    ['BODY_LIMIT_BYTES', '1023'],
    ['BODY_LIMIT_BYTES', '16777217'],
    ['HTTP_HEADERS_TIMEOUT_MS', '999'],
    ['HTTP_REQUEST_TIMEOUT_MS', '300001'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '60001'],
    ['HTTP_MAX_HEADER_BYTES', '8191'],
    ['HTTP_MAX_HEADERS_COUNT', '257'],
    ['HTTP_MAX_REQUESTS_PER_SOCKET', '0'],
  ];
  for (const [key, value] of invalid) {
    assert.throws(() => config({ [key]: value }), /Invalid integer value/u);
  }
});

test('webhook server applies configured HTTP resource budgets', () => {
  const server = createWebhookServer({
    config: config({
      HTTP_HEADERS_TIMEOUT_MS: '7000',
      HTTP_REQUEST_TIMEOUT_MS: '19000',
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '4000',
      HTTP_MAX_HEADER_BYTES: '12288',
      HTTP_MAX_HEADERS_COUNT: '48',
      HTTP_MAX_REQUESTS_PER_SOCKET: '25',
    }),
    ...dependencies(),
  });
  try {
    assert.equal(server.headersTimeout, 7_000);
    assert.equal(server.requestTimeout, 19_000);
    assert.equal(server.keepAliveTimeout, 4_000);
    assert.equal(server.maxHeaderSize, 12_288);
    assert.equal(server.maxHeadersCount, 48);
    assert.equal(server.maxRequestsPerSocket, 25);
  } finally {
    server.close();
  }
});

test('health and readiness responses are non-cacheable, nosniff, and readiness is sampled once', async (t) => {
  let samples = 0;
  const baseUrl = await start(t, {}, () => {
    samples += 1;
    return false;
  });

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ready: false });
  assert.equal(samples, 1);
});

test('webhook ingress rejects malformed GitHub headers before queue access', async (t) => {
  const baseUrl = await start(t);
  const body = JSON.stringify({
    repository: { name: 'ores-gh-bots', owner: { login: 'ORESoftware' } },
  });
  const response = await fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'Pull Request',
      'x-hub-signature-256': signature(body),
    },
    body,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_github_headers' });
});

test('webhook ingress rejects non-object JSON payloads before queue access', async (t) => {
  const baseUrl = await start(t);
  const body = '[]';
  const response = await fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-2',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': signature(body),
    },
    body,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_payload' });
});
