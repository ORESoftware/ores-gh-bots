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

test('acceptWebhook records delivery and jobs atomically', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const first = queue.acceptWebhook({
      deliveryId: 'd-atomic',
      event: 'pull_request',
      action: 'opened',
      jobs: [job()],
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.inserted, 1);
    assert.equal(queue.hasDelivery('d-atomic'), true);
    assert.equal(queue.stats().pending, 1);

    const duplicate = queue.acceptWebhook({
      deliveryId: 'd-atomic',
      event: 'pull_request',
      action: 'opened',
      jobs: [job({ headSha: 'other' })],
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inserted, 0);
    assert.equal(queue.stats().pending, 1);
  } finally { queue.close(); }
});

test('acceptWebhook rolls back the delivery when a job is invalid', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.throws(
      () => queue.acceptWebhook({
        deliveryId: 'd-rollback',
        event: 'issue_comment',
        action: 'created',
        jobs: [job({ installationId: 0 })],
      }),
      /Invalid queue job/,
    );
    assert.equal(queue.hasDelivery('d-rollback'), false);
    assert.equal(queue.stats().pending ?? 0, 0);

    const recovered = queue.acceptWebhook({
      deliveryId: 'd-rollback',
      event: 'issue_comment',
      action: 'created',
      jobs: [job()],
    });
    assert.equal(recovered.duplicate, false);
    assert.equal(recovered.inserted, 1);
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

test('reclaims an expired lease while attempts remain', () => {
  const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 2 });
  try {
    queue.enqueue(job({ maxAttempts: 2 }));
    const first = queue.claimNext('worker-1', -1);
    assert.equal(first.attempts, 1);
    const second = queue.claimNext('worker-2', 30_000);
    assert.equal(second.attempts, 2);
    assert.equal(second.leaseOwner, 'worker-2');
  } finally { queue.close(); }
});

test('dead-letters an expired lease after the final attempt', () => {
  const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 1 });
  try {
    queue.enqueue(job({ maxAttempts: 1 }));
    const first = queue.claimNext('worker-1', -1);
    assert.equal(first.attempts, 1);
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
