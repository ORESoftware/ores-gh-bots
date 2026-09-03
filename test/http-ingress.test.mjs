import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, Metrics } from '../packages/core/src/index.mjs';
import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';

function harnessConfig(overrides = {}) {
  return loadConfig({
    OWNER_ALLOWLIST: 'ORESoftware',
    ...overrides,
  });
}

function createServer(config) {
  const queue = { acceptDelivery() { throw new Error('not used'); } };
  const logger = { info() {}, warn() {}, error() {} };
  return createWebhookServer({ config, queue, logger, metrics: new Metrics() });
}

test('webhook ingress defaults are finite and mutually consistent', () => {
  const config = harnessConfig();
  assert.deepEqual(config.server, {
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
  assert.ok(config.server.headersTimeoutMs <= config.server.requestTimeoutMs);
});

test('integer configuration rejects trailing, fractional, and alternate-base syntax', () => {
  for (const value of ['8080garbage', '1e3', '0x20', '3.5', '+-2']) {
    assert.throws(() => harnessConfig({ PORT: value }), /Invalid integer configuration value/);
  }
  assert.equal(harnessConfig({ PORT: ' 08080 ' }).server.port, 8080);
  assert.equal(harnessConfig({ PORT: '+8080' }).server.port, 8080);
});

test('header receipt cannot outlive the total request deadline', () => {
  assert.throws(
    () => harnessConfig({ HTTP_HEADERS_TIMEOUT_MS: '31000', HTTP_REQUEST_TIMEOUT_MS: '30000' }),
    /must not exceed/,
  );
  assert.doesNotThrow(
    () => harnessConfig({ HTTP_HEADERS_TIMEOUT_MS: '30000', HTTP_REQUEST_TIMEOUT_MS: '30000' }),
  );
});

test('webhook server applies connection, header-count, and socket-reuse budgets', () => {
  const config = harnessConfig({
    HTTP_HEADERS_TIMEOUT_MS: '7000',
    HTTP_REQUEST_TIMEOUT_MS: '19000',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '3000',
    HTTP_MAX_HEADER_BYTES: '8192',
    HTTP_MAX_HEADERS_COUNT: '32',
    HTTP_MAX_REQUESTS_PER_SOCKET: '17',
  });
  const server = createServer(config);
  assert.equal(server.headersTimeout, 7000);
  assert.equal(server.requestTimeout, 19000);
  assert.equal(server.keepAliveTimeout, 3000);
  assert.equal(server.maxHeadersCount, 32);
  assert.equal(server.maxRequestsPerSocket, 17);
});

test('unsafe ingress extremes fail during configuration load', () => {
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
    assert.throws(() => harnessConfig({ [key]: value }), /Invalid integer configuration value/);
  }
});
