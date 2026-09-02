import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countUnresolvedReviewThreads,
  listPullRequestReviews,
  mergePullRequestExact,
} from '../packages/github/src/merge-reaper.mjs';

test('review thread audit paginates and counts only unresolved threads', async () => {
  const calls = [];
  const client = {
    async request(method, path, options) {
      calls.push({ method, path, options });
      const cursor = options.body.variables.cursor;
      if (cursor === null) {
        return { data: { data: { repository: { pullRequest: { reviewThreads: {
          nodes: [{ isResolved: false }, { isResolved: true }],
          pageInfo: { hasNextPage: true, endCursor: 'next' },
        } } } } } };
      }
      return { data: { data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ isResolved: false }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } } };
    },
  };
  assert.equal(await countUnresolvedReviewThreads(client, 'token', 'o', 'r', 1), 2);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.path === '/graphql'), true);
});

test('pull request reviews use bounded authenticated pagination', async () => {
  const client = {
    async paginate(path, options) {
      assert.match(path, /\/pulls\/3\/reviews\?per_page=100$/u);
      assert.equal(options.token, 'token');
      return [{ id: 1 }];
    },
  };
  assert.deepEqual(await listPullRequestReviews(client, 'token', 'o', 'r', 3), [{ id: 1 }]);
});

test('exact merge re-fetches mutable state and pins the merge request SHA', async () => {
  const calls = [];
  const sha = 'a'.repeat(40);
  const client = {
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      if (method === 'GET') return { data: { state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha } } };
      if (method === 'PUT') return { data: { merged: true, sha: 'b'.repeat(40) } };
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  };
  const result = await mergePullRequestExact(client, 'token', 'o', 'r', 8, {
    expectedHeadSha: sha,
    method: 'squash',
    commitTitle: 'Title',
  });
  assert.equal(result.merged, true);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'PUT']);
  assert.equal(calls[1].options.body.sha, sha);
  assert.equal(calls[1].options.body.merge_method, 'squash');
});

test('exact merge refuses stale heads before any write', async () => {
  const calls = [];
  const client = {
    async request(method) {
      calls.push(method);
      return { data: { state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'b'.repeat(40) } } };
    },
  };
  await assert.rejects(
    mergePullRequestExact(client, 'token', 'o', 'r', 8, { expectedHeadSha: 'a'.repeat(40) }),
    /head changed/u,
  );
  assert.deepEqual(calls, ['GET']);
});

test('review thread audit rejects GraphQL errors, missing pull requests, broken cursors, and page exhaustion', async () => {
  const errorsClient = { async request() { return { data: { errors: [{ message: 'denied' }] } }; } };
  await assert.rejects(countUnresolvedReviewThreads(errorsClient, 't', 'o', 'r', 1), /denied/u);

  const missingClient = { async request() { return { data: { data: { repository: { pullRequest: null } } } }; } };
  await assert.rejects(countUnresolvedReviewThreads(missingClient, 't', 'o', 'r', 1), /did not return/u);

  const cursorClient = { async request() { return { data: { data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: null },
  } } } } } }; } };
  await assert.rejects(countUnresolvedReviewThreads(cursorClient, 't', 'o', 'r', 1), /end cursor/u);

  const endlessClient = { async request() { return { data: { data: { repository: { pullRequest: { reviewThreads: {
    nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' },
  } } } } } }; } };
  await assert.rejects(countUnresolvedReviewThreads(endlessClient, 't', 'o', 'r', 1, { maxPages: 1 }), /exceeded 1 pages/u);
});

test('exact merge input and mutable-state validation remain fail closed', async () => {
  const unexpected = { async request() { throw new Error('must not call'); } };
  await assert.rejects(mergePullRequestExact(unexpected, 't', 'o', 'r', 1, { expectedHeadSha: 'bad' }), /expectedHeadSha/u);
  await assert.rejects(mergePullRequestExact(unexpected, 't', 'o', 'r', 1, { expectedHeadSha: 'a'.repeat(40), method: 'force' }), /Unsupported/u);

  for (const [current, pattern] of [
    [{ state: 'closed', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } }, /no longer open/u],
    [{ state: 'open', draft: true, mergeable: true, mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } }, /became a draft/u],
    [{ state: 'open', draft: false, mergeable: false, mergeable_state: 'dirty', head: { sha: 'a'.repeat(40) } }, /not cleanly mergeable/u],
  ]) {
    const client = { async request() { return { data: current }; } };
    await assert.rejects(mergePullRequestExact(client, 't', 'o', 'r', 1, { expectedHeadSha: 'a'.repeat(40) }), pattern);
  }
});

test('GitHub merge refusal is surfaced without pretending success', async () => {
  const sha = 'a'.repeat(40);
  let count = 0;
  const client = {
    async request(method) {
      count += 1;
      if (method === 'GET') return { data: { state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha } } };
      return { data: { merged: false, message: 'branch protection rejected merge' } };
    },
  };
  await assert.rejects(
    mergePullRequestExact(client, 't', 'o', 'r', 1, {
      expectedHeadSha: sha,
      commitMessage: 'message',
    }),
    /branch protection rejected merge/u,
  );
  assert.equal(count, 2);
});
