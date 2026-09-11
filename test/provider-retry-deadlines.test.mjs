import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfterMs, postJson, ProviderHttpError } from '../packages/providers/src/http.mjs';

const request = {
  provider: 'TestProvider', url: 'https://provider.example/v1/review',
  headers: { authorization: 'Bearer fake-unit-test-value' }, body: { hello: 'world' },
  timeoutMs: 5_000,
};
const ok = () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
const rejectCode = (code) => (error) => { assert.equal(error.code, code); return true; };

for (const status of [400, 401, 403, 404, 422, 501]) {
  test(`HTTP ${status} is never retried even with Retry-After`, async () => {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(postJson({ ...request,
      fetchImpl: async () => { calls += 1; return new Response('private echoed input', { status, headers: { 'retry-after': '0' } }); },
      sleepImpl: async () => { sleeps += 1; },
    }), (error) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.stack, /private echoed input/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  });
}

for (const status of [429, 500, 502, 503, 504, 529]) {
  test(`HTTP ${status} retries a malformed error body, then accepts valid JSON`, async () => {
    let calls = 0;
    const delays = [];
    const result = await postJson({ ...request,
      fetchImpl: async () => ++calls === 1
        ? new Response('<html>not JSON</html>', { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } })
        : ok(),
      sleepImpl: async (delay, _value, options) => { delays.push(delay); assert.ok(options.signal instanceof AbortSignal); },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [0]);
  });
}

test('retry budget is finite with bounded exponential waits', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(postJson({ ...request, fetchImpl: async () => { calls += 1; return new Response('busy', { status: 503 }); },
    sleepImpl: async (delay) => { waits.push(delay); },
  }), (error) => error instanceof ProviderHttpError && error.status === 503);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [750, 1500]);
});

test('server retry opt-out is honored', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, fetchImpl: async () => {
    calls += 1;
    return new Response('busy', { status: 503, headers: { 'retry-after': '0', 'x-should-retry': 'false' } });
  } }), ProviderHttpError);
  assert.equal(calls, 1);
});

test('Retry-After parser rejects negative, fractional, and permissive date inputs', () => {
  for (const value of [null, '', '-1', '1.5', 'Infinity', '1e9', '+2', 'tomorrow', '0x20']) assert.equal(parseRetryAfterMs(value), null);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(' 2 '), 2000);
  assert.equal(parseRetryAfterMs('9'.repeat(400)), Number.MAX_SAFE_INTEGER);
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:02 GMT', now), 2000);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:27:00 GMT', now), 0);
});

for (const value of ['3600', '9'.repeat(400), 'Fri, 01 Jan 2100 00:00:00 GMT']) {
  test(`oversized Retry-After (${value.slice(0, 20)}) never becomes an early retry`, async () => {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(postJson({ ...request, fetchImpl: async () => {
      calls += 1; return new Response('busy', { status: 429, headers: { 'retry-after': value } });
    }, sleepImpl: async () => { sleeps += 1; } }), ProviderHttpError);
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  });
}

test('server-requested wait beyond the remaining deadline is not shortened', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, timeoutMs: 100,
    fetchImpl: async () => { calls += 1; return new Response('busy', { status: 429, headers: { 'retry-after': '1' } }); },
    sleepImpl: () => { throw new Error('must not sleep'); },
  }), (error) => error instanceof ProviderHttpError && error.retryAfterMs === 1000);
  assert.equal(calls, 1);
});

test('pre-cancelled requests never touch the transport or echo the cancellation reason', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));
  let calls = 0;
  await assert.rejects(postJson({ ...request, signal: controller.signal, fetchImpl: async () => { calls += 1; return ok(); } }), (error) => {
    assert.equal(error.code, 'PROVIDER_CANCELLED');
    assert.doesNotMatch(error.stack, /private abort reason/);
    return true;
  });
  assert.equal(calls, 0);
});

test('cancellation interrupts a retry wait without another POST', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(postJson({ ...request, signal: controller.signal,
    fetchImpl: async () => { calls += 1; return new Response('busy', { status: 503 }); },
    sleepImpl: (_delay, _value, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      controller.abort();
      return new Promise(() => {});
    },
  }), rejectCode('PROVIDER_CANCELLED'));
  assert.equal(calls, 1);
});

test('one deadline terminates a transport that never settles', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, timeoutMs: 20,
    fetchImpl: () => { calls += 1; return new Promise(() => {}); },
  }), rejectCode('PROVIDER_TIMEOUT'));
  assert.equal(calls, 1);
});

test('one deadline terminates an uncooperative retry sleeper', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, timeoutMs: 20,
    fetchImpl: async () => { calls += 1; return new Response('busy', { status: 503, headers: { 'retry-after': '0' } }); },
    sleepImpl: () => new Promise(() => {}),
  }), rejectCode('PROVIDER_TIMEOUT'));
  assert.equal(calls, 1);
});

test('one deadline cancels a stalled response stream without waiting for cancellation', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  await assert.rejects(postJson({ ...request, timeoutMs: 20,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  }), rejectCode('PROVIDER_TIMEOUT'));
  assert.equal(cancelled, true);
});

test('overflow cancels the body and does not wait for a hanging cancellation', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2048)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  await assert.rejects(postJson({ ...request, maxResponseBytes: 1024,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  }), rejectCode('PROVIDER_RESPONSE_LIMIT'));
  assert.equal(cancelled, true);
});

test('unstreamed transports cannot fall back to an unbounded text allocation', async () => {
  let textCalled = false;
  await assert.rejects(postJson({ ...request, fetchImpl: async () => ({
    ok: true, headers: new Headers({ 'content-type': 'application/json' }), body: {},
    text: async () => { textCalled = true; return '{}'; },
  }) }), rejectCode('PROVIDER_PROTOCOL'));
  assert.equal(textCalled, false);
});

test('malformed successful JSON does not leak its content or receive retries', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, fetchImpl: async () => {
    calls += 1; return new Response('{private unknown credential}', { headers: { 'content-type': 'application/json' } });
  } }), (error) => {
    assert.equal(error.code, 'PROVIDER_PROTOCOL');
    assert.doesNotMatch(error.stack, /private unknown credential/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('successful HTML is rejected but JSON media type parameters remain valid', async () => {
  await assert.rejects(postJson({ ...request, fetchImpl: async () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } }) }), rejectCode('PROVIDER_PROTOCOL'));
  assert.deepEqual(await postJson({ ...request, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json; charset=utf-8' } }) }), {});
});

test('transport exceptions are sanitized and ambiguous POSTs are not retried', async () => {
  let calls = 0;
  await assert.rejects(postJson({ ...request, fetchImpl: async () => { calls += 1; throw new Error('Bearer private-unknown-secret'); } }), (error) => {
    assert.equal(error.code, 'PROVIDER_TRANSPORT');
    assert.doesNotMatch(error.stack, /private-unknown-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('configuration validation precedes every network request', async () => {
  const cases = [
    ['timeoutMs', 0], ['timeoutMs', Infinity], ['timeoutMs', 2 ** 31], ['timeoutMs', 0.5],
    ['retries', -1], ['retries', 6], ['retries', 1.5], ['retries', NaN],
    ['maxRetryDelayMs', 0], ['maxRetryDelayMs', 60_001],
    ['maxResponseBytes', 2 ** 30], ['maxResponseBytes', NaN], ['signal', {}],
  ];
  let calls = 0;
  for (const [field, value] of cases) {
    await assert.rejects(postJson({ ...request, [field]: value, fetchImpl: async () => { calls += 1; return ok(); } }), new RegExp(field));
  }
  assert.equal(calls, 0);
});
