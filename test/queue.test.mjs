import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { SqliteQueue } from '../packages/queue/src/index.mjs';

function job(overrides = {}) {
  return {
    type: 'review', installationId: 1, owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', reason: 'test', ...overrides,
  };
}

test('deduplicates webhook deliveries and coalesces forced SHA jobs', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.equal(queue.markDelivery('d1', 'pull_request', 'opened'), true);
    assert.equal(queue.markDelivery('d1', 'pull_request', 'opened'), false);
    assert.equal(queue.enqueue(job()).inserted, true);
    assert.equal(queue.enqueue(job()).inserted, false);
    assert.equal(queue.enqueue(job({ force: true })).inserted, false);

    const claimed = queue.claimNext('worker', 30_000);
    assert.equal(queue.complete(claimed.id, 'worker'), true);
    const requeued = queue.enqueue(job({ force: true, reason: 'manual-rerun' }));
    assert.equal(requeued.inserted, true);
    assert.equal(requeued.job.status, 'pending');
    assert.equal(requeued.job.attempts, 0);
    assert.equal(requeued.job.reason, 'manual-rerun');
    assert.equal(queue.enqueue(job({ force: true })).inserted, false);
  } finally { queue.close(); }
});

test('dedupe keys include the installation identity', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.equal(queue.enqueue(job({ installationId: 1 })).inserted, true);
    assert.equal(queue.enqueue(job({ installationId: 2 })).inserted, true);
    assert.equal(queue.stats().pending, 2);
  } finally { queue.close(); }
});

test('leases, completes, and reports queue jobs', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    queue.enqueue(job());
    const claimed = queue.claimNext('worker', 30_000);
    assert.equal(claimed.attempts, 1);
    assert.equal(queue.heartbeat(claimed.id, 'worker', 30_000), true);
    assert.equal(queue.complete(claimed.id, 'worker'), true);
    assert.equal(queue.stats().completed, 1);
  } finally { queue.close(); }
});

test('retries failures and eventually dead-letters', () => {
  const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 1 });
  try {
    queue.enqueue(job({ maxAttempts: 1 }));
    const claimed = queue.claimNext('worker', 30_000);
    const outcome = queue.fail(claimed, 'worker', 'boom');
    assert.equal(outcome.dead, true);
    assert.equal(queue.stats().dead, 1);
  } finally { queue.close(); }
});

test('reclaims an expired lease while attempts remain', async () => {
  const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 2 });
  try {
    queue.enqueue(job({ maxAttempts: 2 }));
    const first = queue.claimNext('worker-1', 1);
    assert.equal(first.attempts, 1);
    await sleep(5);
    const second = queue.claimNext('worker-2', 30_000);
    assert.equal(second.attempts, 2);
    assert.equal(second.leaseOwner, 'worker-2');
  } finally { queue.close(); }
});

test('dead-letters an expired lease after the final attempt', async () => {
  const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 1 });
  try {
    queue.enqueue(job({ maxAttempts: 1 }));
    const first = queue.claimNext('worker-1', 1);
    assert.equal(first.attempts, 1);
    await sleep(5);
    assert.equal(queue.claimNext('worker-2', 30_000), null);
    assert.equal(queue.stats().dead, 1);
    assert.equal(queue.stats().pending ?? 0, 0);
  } finally { queue.close(); }
});

test('persists provider results per exact SHA', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    queue.recordReview({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', provider: 'openai', result: { verdict: 'approve' }, checkRunId: 42 });
    queue.recordReview({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', provider: 'claude', error: 'provider unavailable', checkRunId: 43 });
    const reviews = queue.getReviews({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc' });
    assert.equal(reviews.openai.verdict, 'approve');
    assert.equal(reviews.openai.checkRunId, 42);
    assert.match(reviews.claude.error, /unavailable/);
    assert.deepEqual(queue.getReviews({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'new' }), {});
  } finally { queue.close(); }
});

test('prunes old deliveries, terminal jobs, and review evidence', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    queue.markDelivery('old', 'pull_request', 'opened');
    queue.enqueue(job());
    const claimed = queue.claimNext('worker', 30_000);
    queue.complete(claimed.id, 'worker');
    queue.recordReview({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', provider: 'openai', result: { verdict: 'approve' } });
    const pruned = queue.prune({
      deliveriesBefore: Date.now() + 1,
      completedBefore: Date.now() + 1,
      deadBefore: Date.now() + 1,
      reviewsBefore: Date.now() + 1,
    });
    assert.deepEqual(pruned, { deliveries: 1, jobs: 1, reviews: 1 });
  } finally { queue.close(); }
});
