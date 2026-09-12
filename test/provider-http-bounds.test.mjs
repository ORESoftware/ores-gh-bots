import test from 'node:test';
import assert from 'node:assert/strict';
import { postJson } from '../packages/providers/src/index.mjs';

const request = {
  provider: 'TestProvider',
  url: 'https://provider.example/v1/review',
  headers: { authorization: 'Bearer secret' },
  body: { hello: 'world' },
  timeoutMs: 5_000,
  retries: 0,
};

test('provider requests disable implicit redirects', async () => {
  let options;
  const result = await postJson({
    ...request,
    fetchImpl: async (_url, value) => {
      options = value;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(options.redirect, 'error');
  assert.deepEqual(result, { ok: true });
});

test('provider responses reject oversized declared content length', async () => {
  await assert.rejects(
    postJson({
      ...request,
      maxResponseBytes: 1024,
      fetchImpl: async () => new Response('small', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': '2048',
        },
      }),
    }),
    /response exceeded 1024 bytes/,
  );
});

test('provider responses reject oversized chunked bodies', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(800));
      controller.enqueue(new Uint8Array(800));
      controller.close();
    },
  });
  await assert.rejects(
    postJson({
      ...request,
      maxResponseBytes: 1024,
      fetchImpl: async () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    }),
    /response exceeded 1024 bytes/,
  );
});

test('provider response limit configuration fails closed', async () => {
  await assert.rejects(
    postJson({
      ...request,
      maxResponseBytes: 100,
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    /maxResponseBytes must be an integer >= 1024/,
  );
});
