import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewerQueue,
  currentHeadReview,
  submitBoundReviewerApproval,
} from '../packages/github/src/index.mjs';

const SHA = 'a'.repeat(40);

function pullRequest({ owner = 'acme', repo = 'widget', number = 7 } = {}) {
  return {
    number,
    state: 'open',
    draft: false,
    title: 'Preserve reviewer intent',
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    updated_at: '2026-09-08T12:00:00Z',
    user: { login: 'alice' },
    requested_reviewers: [{ login: 'the1mills' }],
    head: { sha: SHA },
  };
}

test('a later informational comment does not hide an effective current-head approval', () => {
  const review = currentHeadReview([
    {
      id: 10,
      state: 'APPROVED',
      commit_id: SHA,
      submitted_at: '2026-09-08T12:00:00Z',
      user: { login: 'the1mills' },
    },
    {
      id: 11,
      state: 'COMMENTED',
      commit_id: SHA,
      submitted_at: '2026-09-08T13:00:00Z',
      user: { login: 'the1mills' },
    },
  ], 'the1mills', SHA);
  assert.equal(review.id, 10);
  assert.equal(review.state, 'APPROVED');
});

test('an explicit review request cannot be starved by lexical mentions when the queue is bounded', async () => {
  const client = {
    apiOrigin: 'https://api.github.com',
    async paginate(path, options) {
      const response = await this.request('GET', path, { token: options.token });
      return options.map(response.data);
    },
    async request(method, path) {
      if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' } };
      if (path.startsWith('/search/issues')) {
        const query = decodeURIComponent(path);
        if (query.includes('review-requested')) return { data: { items: [{
          number: 1,
          pull_request: {},
          repository_url: 'https://api.github.com/repos/zzz/requested',
        }] } };
        if (query.includes('mentions')) return { data: { items: [{
          number: 2,
          pull_request: {},
          repository_url: 'https://api.github.com/repos/aaa/mentioned',
        }] } };
        return { data: { items: [] } };
      }
      if (method === 'GET' && path === '/repos/zzz/requested/pulls/1') {
        return { data: pullRequest({ owner: 'zzz', repo: 'requested', number: 1 }) };
      }
      if (path === '/repos/zzz/requested/pulls/1/reviews?per_page=100') return { data: [] };
      if (path === '/repos/zzz/requested/collaborators/the1mills/permission') return { data: { permission: 'write' } };
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };

  const queue = await buildReviewerQueue({ client, token: 'token', reviewerLogin: 'the1mills', limit: 1 });
  assert.equal(queue.count, 1);
  assert.equal(queue.candidates[0].repository, 'zzz/requested');
  assert.deepEqual(queue.candidates[0].sources, ['review-requested']);
  assert.equal(queue.candidates[0].disposition, 'review');
});

test('a manual current-head change request arriving during gate verification blocks approval', async () => {
  let reviewReads = 0;
  const requests = [];
  const client = {
    async request(method, path, options = {}) {
      requests.push({ method, path, options });
      if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' } };
      if (method === 'GET' && path === '/repos/acme/widget/pulls/7') return { data: pullRequest() };
      if (path === '/repos/acme/widget/pulls/7/reviews?per_page=100') {
        reviewReads += 1;
        return { data: reviewReads === 1 ? [] : [{
          id: 91,
          state: 'CHANGES_REQUESTED',
          commit_id: SHA,
          submitted_at: '2026-09-08T13:00:00Z',
          user: { login: 'the1mills' },
        }] };
      }
      if (path === '/repos/acme/widget/collaborators/the1mills/permission') return { data: { permission: 'write' } };
      if (path === '/repos/acme/widget/check-runs/99') return { data: {
        id: 99,
        name: 'ores-review/gate',
        head_sha: SHA,
        external_id: `gate:acme/widget#7@${SHA}`,
        app: { id: 42 },
        status: 'completed',
        conclusion: 'success',
      } };
      if (method === 'POST') return { data: { id: 123 } };
      throw new Error(`Unexpected ${method} ${path}`);
    },
    async paginate(path, options) {
      const response = await this.request('GET', path, { token: options.token });
      return options.map(response.data);
    },
  };

  await assert.rejects(() => submitBoundReviewerApproval({
    client,
    token: 'token',
    reviewerLogin: 'the1mills',
    owner: 'acme',
    repo: 'widget',
    prNumber: 7,
    expectedHeadSha: SHA,
    body: 'Gate is green.',
    gateCheckRunId: 99,
    gateAppId: 42,
  }), /requested changes on the current pull request head/u);
  assert.equal(requests.some((request) => request.method === 'POST'), false);
  assert.equal(reviewReads, 2);
});
