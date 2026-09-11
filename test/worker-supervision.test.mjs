import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createWorkerPool, startWorkerPool, WorkerPoolError } from '../apps/orchestrator/src/worker.mjs';
import { createWebhookServer } from '../apps/orchestrator/src/server.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const controller = new AbortController();
  const fatal = [];
  const logs = [];
  const queue = {
    claimNext: () => null,
    heartbeat: () => true,
    complete: () => true,
    fail: () => ({ updated: true, dead: false, delayMs: 2_000 }),
    ...overrides.queue,
  };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push({ level, args })]));
  const options = {
    queue,
    engine: overrides.engine ?? { process: async () => {} },
    config: {
      queue: { workerConcurrency: overrides.concurrency ?? 2, leaseMs: 30_000, pollMs: 60_000 },
      apps: {
        openai: { id: 101 },
        claude: { id: 102 },
        gate: { id: 103 },
      },
      review: { requiredCiContexts: [] },
      server: { webhookPath: '/webhooks/github', bodyLimitBytes: 1024 },
      github: { webhookSecret: 'unused-by-readiness-test' },
    },
    logger,
    metrics: { increment() {}, render: () => '' },
    signal: controller.signal,
    onFatal: (error) => fatal.push(error),
  };
  return { options, controller, fatal, logs, queue };
}

const job = { id: 1, owner: 'ORESoftware', repo: 'ores-gh-bots', prNumber: 7, type: 'review', attempts: 1 };

test('pool is healthy only while every configured worker is live', async () => {
  const h = harness();
  const pool = createWorkerPool(h.options);
  assert.equal(pool.isHealthy(), false);
  await nextTurn();
  assert.equal(pool.isHealthy(), true);
  assert.deepEqual(pool.snapshot(), { expected: 2, active: 2, failed: false, stopping: false });
  h.controller.abort();
  assert.equal(pool.isHealthy(), false);
  const results = await pool.done;
  assert.ok(results.every((result) => result.status === 'fulfilled'));
  assert.equal(pool.snapshot().active, 0);
  assert.equal(h.fatal.length, 0);
});

test('claim failure stops sibling workers and reports one fatal error', async () => {
  let claims = 0;
  const h = harness({ queue: { claimNext() { claims += 1; throw new Error('database unavailable'); } } });
  const pool = createWorkerPool(h.options);
  const results = await pool.done;
  assert.equal(pool.isHealthy(), false);
  assert.equal(pool.snapshot().failed, true);
  assert.equal(h.fatal.length, 1);
  assert.match(h.fatal[0].message, /database unavailable/);
  assert.ok(results.some((result) => result.status === 'rejected'));
  const stoppedAt = claims;
  await nextTurn();
  assert.equal(claims, stoppedAt);
});

test('onFatal runs immediately but done waits for another active engine to drain', async () => {
  const running = deferred();
  let claims = 0;
  let completions = 0;
  const h = harness({
    queue: {
      claimNext() { if (++claims === 1) return job; throw new Error('claim failed'); },
      complete() { completions += 1; return true; },
    },
    engine: { process: () => running.promise },
  });
  const pool = createWorkerPool(h.options);
  let done = false;
  pool.done.then(() => { done = true; });
  await nextTurn();
  assert.equal(h.fatal.length, 1);
  assert.equal(pool.isHealthy(), false);
  assert.equal(done, false);
  running.resolve();
  await pool.done;
  assert.equal(completions, 1);
  assert.equal(done, true);
});

test('ordinary engine errors remain durable job retries, not pool crashes', async () => {
  let claims = 0;
  let failures = 0;
  const h = harness({ concurrency: 1, queue: {
    claimNext() { return ++claims === 1 ? job : null; },
    fail() { failures += 1; return { updated: true, dead: false, delayMs: 2_000 }; },
  }, engine: { process: async () => { throw new Error('provider unavailable'); } } });
  const pool = createWorkerPool(h.options);
  await nextTurn();
  assert.equal(failures, 1);
  assert.equal(pool.isHealthy(), true);
  assert.equal(h.fatal.length, 0);
  pool.stop();
  await pool.done;
});

for (const kind of ['complete throws', 'complete loses lease', 'fail throws', 'fail loses lease']) {
  test(`${kind} is a fatal infrastructure failure`, async () => {
    let claimed = false;
    const h = harness({ concurrency: 1, queue: {
      claimNext() { if (claimed) return null; claimed = true; return job; },
      complete() { if (kind === 'complete throws') throw new Error('SQLite write failed'); return false; },
      fail() { if (kind === 'fail throws') throw new Error('SQLite retry write failed'); return { updated: false }; },
    }, engine: { process: async () => { if (kind.startsWith('fail')) throw new Error('engine error'); } } });
    const pool = createWorkerPool(h.options);
    const results = await pool.done;
    assert.equal(results[0].status, 'rejected');
    assert.equal(h.fatal.length, 1);
    assert.equal(pool.isHealthy(), false);
  });
}

for (const mode of ['throws', 'loses lease']) {
  test(`heartbeat ${mode} is caught and never acknowledges a stale lease`, async (t) => {
    const running = deferred();
    let pulse;
    let cleared = 0;
    t.mock.method(globalThis, 'setInterval', (callback) => { pulse = callback; return { unref() {} }; });
    t.mock.method(globalThis, 'clearInterval', () => { cleared += 1; });
    let claimed = false;
    let writes = 0;
    const h = harness({ concurrency: 1, queue: {
      claimNext() { if (claimed) return null; claimed = true; return job; },
      heartbeat() { if (mode === 'throws') throw new Error('heartbeat database error'); return false; },
      complete() { writes += 1; return true; },
      fail() { writes += 1; return { updated: true }; },
    }, engine: { process: () => running.promise } });
    const pool = createWorkerPool(h.options);
    await nextTurn();
    assert.doesNotThrow(() => pulse());
    assert.equal(pool.isHealthy(), false);
    assert.equal(h.fatal.length, 1);
    pulse();
    assert.equal(h.fatal.length, 1);
    running.resolve();
    const results = await pool.done;
    assert.equal(results[0].status, 'rejected');
    assert.equal(writes, 0);
    assert.equal(cleared, 1);
  });
}

test('pre-aborted startup claims nothing and the promise API remains compatible', async () => {
  let claims = 0;
  const h = harness({ queue: { claimNext() { claims += 1; return null; } } });
  h.controller.abort();
  const promise = startWorkerPool(h.options);
  assert.equal(typeof promise.then, 'function');
  await promise;
  assert.equal(claims, 0);
  assert.equal(h.fatal.length, 0);
});

test('invalid concurrency fails closed before starting workers', () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, 65, '2']) {
    const h = harness({ concurrency });
    assert.throws(() => createWorkerPool(h.options), WorkerPoolError);
  }
});

test('fatal callback failure does not become an unhandled pool rejection', async () => {
  const h = harness({ queue: { claimNext() { throw new Error('claim error'); } } });
  h.options.onFatal = () => { throw new Error('observer error'); };
  const pool = createWorkerPool(h.options);
  await pool.done;
  assert.equal(pool.snapshot().failed, true);
  assert.ok(h.logs.some((entry) => entry.args[0] === 'worker failure callback failed'));
});

test('HTTP readiness turns 503 while a failed pool still drains an active job', async (t) => {
  const running = deferred();
  let claimed = false;
  const h = harness({ concurrency: 1, queue: { claimNext() { if (claimed) return null; claimed = true; return job; } },
    engine: { process: () => running.promise } });
  let pulse;
  t.mock.method(globalThis, 'setInterval', (callback) => { pulse = callback; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const pool = createWorkerPool(h.options);
  const server = createWebhookServer({ ...h.options, readiness: () => pool.isHealthy() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { running.resolve(); pool.stop(); await pool.done; await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/readyz`;
  assert.equal((await fetch(url)).status, 200);
  h.queue.heartbeat = () => false;
  pulse();
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ready: false });
  assert.equal(pool.snapshot().active, 1);
});

test('orchestrator connects readiness and drains workers before closing SQLite', async () => {
  const source = await readFile(new URL('../apps/orchestrator/src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /readiness: \(\) => ready && workerPool\.isHealthy\(\)/);
  assert.match(source, /await workerPool\.done;\s+queue\.close\(\)/);
  assert.match(source, /if \(shutdownPromise\) return shutdownPromise/);
  assert.match(source, /ready = !abortController\.signal\.aborted/);
});

for (const thrown of [null, undefined, false, 'failure']) {
  test(`non-Error engine throw (${String(thrown)}) is never acknowledged as success`, async () => {
    let claimed = false;
    let failures = 0;
    let completions = 0;
    const h = harness({ concurrency: 1, queue: {
      claimNext() { if (claimed) return null; claimed = true; return job; },
      fail() { failures += 1; return { updated: true, dead: false, delayMs: 2_000 }; },
      complete() { completions += 1; return true; },
    }, engine: { process: async () => { throw thrown; } } });
    const pool = createWorkerPool(h.options);
    await nextTurn();
    assert.equal(failures, 1);
    assert.equal(completions, 0);
    pool.stop();
    await pool.done;
  });
}
