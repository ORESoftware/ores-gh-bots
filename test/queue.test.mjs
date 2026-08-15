import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteQueue } from '../packages/queue/src/index.mjs';

function job(overrides = {}) {
  return {
    type: 'review', installationId: 1, owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', reason: 'test', ...overrides,
  };
}

test('deduplicates webhook deliveries and stable SHA jobs', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.equal(queue.markDelivery('d1', 'pull_request', 'opened'), true);
    assert.equal(queue.markDelivery('d1', 'pull_request', 'opened'), false);
    assert.equal(queue.enqueue(job()).inserted, true);
    assert.equal(queue.enqueue(job()).inserted, false);
    assert.equal(queue.enqueue(job({ force: true })).inserted, true);
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
