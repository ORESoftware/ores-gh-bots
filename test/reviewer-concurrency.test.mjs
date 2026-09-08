import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewerQueue } from '../packages/github/src/index.mjs';

const SHA = 'a'.repeat(40);

function headers() {
  return { get() { return null; } };
}

class StubClient {
  constructor() {
    this.apiOrigin = 'https://api.github.com';
    this.activePullReads = 0;
    this.maxActivePullReads = 0;
  }

  async paginate(path, options = {}) {
    const response = await this.request('GET', path, { token: options.token });
    return options.map(response.data);
  }

  async request(method, path) {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (path.startsWith('/search/issues')) {
      const query = decodeURIComponent(path);
      return { data: { items: query.includes('review-requested')
        ? Array.from({ length: 8 }, (_, index) => ({
          number: index + 1,
          pull_request: {},
          repository_url: `https://api.github.com/repos/acme/repo-${index + 1}`,
        }))
        : [] }, headers: headers() };
    }
    const pullMatch = path.match(/\/repos\/acme\/repo-(\d+)\/pulls\/(\d+)$/u);
    if (method === 'GET' && pullMatch) {
      this.activePullReads += 1;
      this.maxActivePullReads = Math.max(this.maxActivePullReads, this.activePullReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.activePullReads -= 1;
      return { data: {
        number: Number(pullMatch[2]),
        state: 'open',
        draft: false,
        title: 'Bound concurrency',
        html_url: `https://github.com/acme/repo-${pullMatch[1]}/pull/${pullMatch[2]}`,
        updated_at: '2026-09-08T12:00:00Z',
        user: { login: 'alice' },
        requested_reviewers: [{ login: 'the1mills' }],
        head: { sha: SHA },
      }, headers: headers() };
    }
    if (path.includes('/reviews?per_page=100')) return { data: [], headers: headers() };
    if (path.includes('/collaborators/the1mills/permission')) return { data: { permission: 'write' }, headers: headers() };
    throw new Error(`Unexpected ${method} ${path}`);
  }
}

test('reviewer queue bounds concurrent live pull-request inspection', async () => {
  const client = new StubClient();
  const queue = await buildReviewerQueue({ client, token: 'token', limit: 8 });
  assert.equal(queue.count, 8);
  assert.equal(client.maxActivePullReads, 4);
});
