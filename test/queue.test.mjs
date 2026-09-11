import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a forced event received during execution schedules exactly one follow-up run', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    queue.enqueue(job());
    const first = queue.claimNext('worker-1', 30_000);
    assert.equal(first.force, false);

    const rerun = queue.enqueue(job({ force: true, reason: 'edited-during-review' }));
    assert.equal(rerun.inserted, true);
    assert.equal(rerun.job.status, 'running');
    assert.equal(queue.enqueue(job({ force: true, reason: 'coalesced-rerun' })).inserted, true);

    assert.equal(queue.complete(first.id, 'worker-1'), true);
    assert.equal(queue.stats().pending, 1);
    const second = queue.claimNext('worker-2', 30_000);
    assert.equal(second.attempts, 1);
    assert.equal(second.reason, 'coalesced-rerun');
    assert.equal(queue.complete(second.id, 'worker-2'), true);
    assert.equal(queue.stats().completed, 1);
    assert.equal(queue.stats().pending ?? 0, 0);
  } finally { queue.close(); }
});

test('a fresh forced event survives failure or lease expiry on the final attempt', async () => {
  for (const outcome of ['failure', 'lease-expiry']) {
    const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 1 });
    try {
      queue.enqueue(job({ maxAttempts: 1 }));
      const claimed = queue.claimNext('worker-1', 1);
      queue.enqueue(job({ force: true, reason: `rerun-after-${outcome}`, maxAttempts: 1 }));
      if (outcome === 'failure') {
        const failed = queue.fail(claimed, 'worker-1', 'boom');
        assert.equal(failed.dead, false);
        assert.equal(failed.delayMs, 0);
      } else {
        await sleep(5);
      }
      const rerun = queue.claimNext('worker-2', 30_000);
      assert.equal(rerun.reason, `rerun-after-${outcome}`);
      assert.equal(rerun.attempts, 1);
    } finally { queue.close(); }
  }
});

test('delivery de-duplication and derived jobs commit atomically', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.throws(
      () => queue.acceptDelivery('atomic-1', 'pull_request', 'opened', [job(), job({ owner: 'invalid owner' })]),
      /owner is invalid/u,
    );
    const retry = queue.acceptDelivery('atomic-1', 'pull_request', 'opened', [job()]);
    assert.deepEqual(retry, { firstDelivery: true, inserted: 1 });
    assert.deepEqual(
      queue.acceptDelivery('atomic-1', 'pull_request', 'opened', [job()]),
      { firstDelivery: false, inserted: 0 },
    );
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


test('default pruning preserves review evidence for long-lived open pull requests', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    queue.recordReview({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', provider: 'openai', result: { verdict: 'approve' } });
    const pruned = queue.prune({
      deliveriesBefore: Date.now() + 1,
      completedBefore: Date.now() + 1,
      deadBefore: Date.now() + 1,
    });
    assert.equal(pruned.reviews, 0);
    assert.equal(queue.getReviews({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc' }).openai.verdict, 'approve');
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

test('delivery, lease recovery, and exact-SHA review evidence survive a process restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ores-gh-bots-queue-restart-'));
  const path = join(directory, 'queue.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = new SqliteQueue({ path, maxAttempts: 2 });
  assert.deepEqual(first.acceptDelivery('restart-1', 'pull_request', 'opened', [job({ maxAttempts: 2 })]), {
    firstDelivery: true,
    inserted: 1,
  });
  first.recordReview({
    owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc', provider: 'openai',
    result: { verdict: 'approve' }, checkRunId: 42,
  });
  const abandoned = first.claimNext('crashed-worker', 1);
  assert.equal(abandoned.attempts, 1);
  first.close();

  await sleep(5);
  const second = new SqliteQueue({ path, maxAttempts: 2 });
  assert.deepEqual(second.acceptDelivery('restart-1', 'pull_request', 'opened', [job({ maxAttempts: 2 })]), {
    firstDelivery: false,
    inserted: 0,
  });
  assert.equal(second.getReviews({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc' }).openai.checkRunId, 42);
  const recovered = second.claimNext('recovery-worker', 30_000);
  assert.equal(recovered.id, abandoned.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(second.complete(recovered.id, 'recovery-worker'), true);
  second.close();

  const third = new SqliteQueue({ path, maxAttempts: 2 });
  try {
    assert.deepEqual(third.stats(), { completed: 1 });
    assert.equal(third.getReviews({ owner: 'O', repo: 'R', prNumber: 2, headSha: 'abc' }).openai.verdict, 'approve');
  } finally { third.close(); }
});

test('two queue connections never claim the same persisted job', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ores-gh-bots-queue-claim-'));
  const path = join(directory, 'queue.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new SqliteQueue({ path });
  const second = new SqliteQueue({ path });
  try {
    first.enqueue(job({ headSha: 'first' }));
    first.enqueue(job({ headSha: 'second' }));
    const firstClaim = first.claimNext('worker-a', 30_000);
    const secondClaim = second.claimNext('worker-b', 30_000);
    assert.notEqual(firstClaim.id, secondClaim.id);
    assert.notEqual(firstClaim.headSha, secondClaim.headSha);
    assert.equal(first.claimNext('worker-c', 30_000), null);
    assert.equal(second.claimNext('worker-d', 30_000), null);
  } finally {
    second.close();
    first.close();
  }
});
