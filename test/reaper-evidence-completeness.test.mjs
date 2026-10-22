import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../packages/github/src/client.mjs';
import { listMergeReaperPullRequestReviews } from '../packages/github/src/merge-reaper.mjs';
import { listOpenPullRequests } from '../packages/github/src/pull-requests.mjs';

function fakeClient(pages) {
  const client = new GitHubClient();
  const calls = [];
  client.request = async (method, path, { token } = {}) => {
    calls.push({ method, path, token });
    const page = pages[calls.length - 1];
    if (!page) throw new Error('unexpected additional page');
    return {
      data: page.data,
      headers: {
        get(name) {
          return name === 'link' && page.next
            ? '<https://api.github.com/repos/owner/repo/pulls?page=' + (calls.length + 1) + '>; rel="next"'
            : null;
        },
      },
    };
  };
  return { client, calls };
}

test('reaper review history rejects missing later pages instead of using stale review states', async () => {
  const pages = Array.from({ length: 10 }, (_, index) => ({
    data: [{ id: index + 1, state: 'APPROVED', user: { login: 'reviewer' } }],
    next: true,
  }));
  const { client, calls } = fakeClient(pages);
  await assert.rejects(
    listMergeReaperPullRequestReviews(client, 'token', 'owner', 'repo', 1),
    /Pagination limit reached before all evidence was collected/u,
  );
  assert.equal(calls.length, 10);
  assert.ok(calls.every((call) => call.method === 'GET' && call.token === 'token'));
});

test('reaper review history accepts complete pagination and rejects malformed pages', async () => {
  const { client, calls } = fakeClient([
    { data: [{ id: 1 }], next: true },
    { data: [{ id: 2, state: 'CHANGES_REQUESTED' }], next: false },
  ]);
  assert.deepEqual(
    await listMergeReaperPullRequestReviews(client, 'token', 'owner', 'repo', 2),
    [{ id: 1 }, { id: 2, state: 'CHANGES_REQUESTED' }],
  );
  assert.equal(calls.length, 2);
  const malformed = fakeClient([{ data: { unexpectedly: 'not-an-array' }, next: false }]);
  await assert.rejects(
    listMergeReaperPullRequestReviews(malformed.client, 'token', 'owner', 'repo', 2),
    /PR review history response must be an array/u,
  );
});

test('reaper PR inventory rejects unobserved extra open PR pages', async () => {
  const pages = [
    { data: [{ number: 1, head: { ref: 'child' } }], next: true },
  ];
  const strict = fakeClient(pages);
  await assert.rejects(
    listOpenPullRequests(strict.client, 'token', 'owner', 'repo', 100, { requireComplete: true }),
    /Pagination limit reached before all evidence was collected/u,
  );
  assert.equal(strict.calls.length, 1);
  // Ordinary callers retain their previous bounded preview behavior.
  const preview = fakeClient(pages);
  assert.equal((await listOpenPullRequests(preview.client, 'token', 'owner', 'repo', 100)).length, 1);
});

test('reaper PR inventory accepts full multiple-page inventory within declared bound', async () => {
  const { client, calls } = fakeClient([
    { data: [{ number: 1 }], next: true },
    { data: [{ number: 2 }], next: false },
  ]);
  const pulls = await listOpenPullRequests(client, 'token', 'owner', 'repo', 200, { requireComplete: true });
  assert.deepEqual(pulls.map((pull) => pull.number), [1, 2]);
  assert.equal(calls.length, 2);
});
