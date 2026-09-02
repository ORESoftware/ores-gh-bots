import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../packages/core/src/index.mjs';
import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';

function noOpDependencies() {
  return {
    queue: { acceptDelivery() { throw new Error('queue must not be used in configuration tests'); } },
    logger: { info() {}, warn() {}, error() {} },
    metrics: { increment() {}, render() { return ''; } },
  };
}

test('HTTP ingress configuration rejects partial and non-decimal integer values', () => {
  for (const value of ['8080ms', '1e3', '0x10', '12.5', '--1']) {
    assert.throws(() => loadConfig({ PORT: value }), /Invalid integer configuration value/);
  }
  assert.equal(loadConfig({ PORT: ' 8081 ' }).server.port, 8081);
});

test('HTTP ingress configuration is bounded and internally consistent', () => {
  assert.throws(
    () => loadConfig({ HTTP_HEADERS_TIMEOUT_MS: '31000', HTTP_REQUEST_TIMEOUT_MS: '30000' }),
    /must not exceed/,
  );
  assert.throws(() => loadConfig({ HTTP_MAX_HEADER_BYTES: '70000' }), /Invalid integer configuration value/);
  assert.throws(() => loadConfig({ HTTP_MAX_HEADERS_COUNT: '500' }), /Invalid integer configuration value/);
  assert.throws(() => loadConfig({ BODY_LIMIT_BYTES: '20000000' }), /Invalid integer configuration value/);
});

test('webhook server applies every configured HTTP resource budget', () => {
  const config = loadConfig({
    HTTP_HEADERS_TIMEOUT_MS: '7000',
    HTTP_REQUEST_TIMEOUT_MS: '19000',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '4000',
    HTTP_MAX_HEADER_BYTES: '12288',
    HTTP_MAX_HEADERS_COUNT: '48',
    HTTP_MAX_REQUESTS_PER_SOCKET: '25',
  });
  const server = createWebhookServer({ config, ...noOpDependencies() });
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

test('HTTP ingress defaults are finite rather than Node unlimited/default policy', () => {
  const config = loadConfig({});
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
});
