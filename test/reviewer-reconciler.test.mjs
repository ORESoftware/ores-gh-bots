import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewerReconciler } from '../apps/orchestrator/src/reviewer-reconciler.mjs';

const SHA = 'a'.repeat(40);

function pullRequest({ owner = 'acme', repo = 'widget', requested = true } = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    title: 'Change',
    html_url: `https://github.com/${owner}/${repo}/pull/7`,
    updated_at: '2026-09-08T12:00:00Z',
    user: { login: 'alice' },
    requested_reviewers: requested ? [{ login: 'the1mills' }] : [],
    head: { sha: SHA },
    base: { repo: { owner: { login: owner }, name: repo } },
  };
}

class Client {
  constructor({ owner = 'acme', gate = true, afterHead = SHA } = {}) {
    this.owner = owner;
    this.gate = gate;
    this.afterHead = afterHead;
    this.calls = [];
    this.apiOrigin = 'https://api.github.com';
    this.pullReads = 0;
  }
  async paginate(path, options) {
    const response = await this.request('GET', path, { token: options.token });
    return options.map(response.data);
  }
  async request(method, path, options = {}) {
    this.calls.push({ method, path, options });
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' } };
    if (path.startsWith('/search/issues')) {
      const query = decodeURIComponent(path);
      return { data: { items: query.includes('review-requested') ? [{
        number: 7,
        pull_request: {},
        repository_url: `https://api.github.com/repos/${this.owner}/widget`,
      }] : [] } };
    }
    if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: [] };
    if (path.includes('/collaborators/the1mills/permission')) return { data: { permission: 'write' } };
    if (path.includes('/commits/') && path.includes('/check-runs?')) {
      return { data: { check_runs: this.gate ? [{
        id: 99,
        name: 'ores-review/gate',
        head_sha: SHA,
        external_id: `gate:${this.owner}/widget#7@${SHA}`,
        app: { id: 42 },
        status: 'completed',
        conclusion: 'success',
      }] : [] } };
    }
    if (path.endsWith('/check-runs/99')) return { data: {
      id: 99,
      name: 'ores-review/gate',
      head_sha: SHA,
      external_id: `gate:${this.owner}/widget#7@${SHA}`,
      app: { id: 42 },
      status: 'completed',
      conclusion: 'success',
    } };
    if (method === 'GET' && path.endsWith('/pulls/7')) {
      this.pullReads += 1;
      return { data: { ...pullRequest({ owner: this.owner }), head: { sha: this.pullReads >= 4 ? this.afterHead : SHA } } };
    }
    if (method === 'POST' && path.endsWith('/pulls/7/reviews')) return { data: { id: 123 } };
    throw new Error(`Unexpected ${method} ${path}`);
  }
}


function config({ enabled = true, owner = 'acme' } = {}) {
  return {
    reviewer: {
      approvalMode: enabled ? 'requested-gate-success' : 'off',
      token: 'token',
      login: 'the1mills',
      maxItems: 100,
    },
    apps: { gate: { id: '42' } },
    github: { ownerAllowlist: [owner], ownerPatterns: [] },
  };
}

function logger() {
  return { entries: [], info(message, data) { this.entries.push({ level: 'info', message, data }); }, warn(message, data) { this.entries.push({ level: 'warn', message, data }); }, error() {} };
}

function metrics() {
  return { entries: [], increment(name, labels, amount) { this.entries.push({ name, labels, amount }); } };
}

test('reviewer reconciler submits one exact-head approval after the configured gate succeeds', async () => {
  const client = new Client();
  const log = logger();
  const metric = metrics();
  const reconciler = new ReviewerReconciler({ config: config(), client, logger: log, metrics: metric });
  const result = await reconciler.runOnce();
  assert.equal(result.candidates, 1);
  assert.equal(result.actionable, 1);
  assert.equal(result.approved, 1);
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.options.body.event, 'APPROVE');
  assert.equal(post.options.body.commit_id, SHA);
  assert.equal(log.entries.at(-1).message, 'bound reviewer reconciliation complete');
  assert.equal(metric.entries.some((entry) => entry.name === 'ores_reviewer_approvals_total' && entry.amount === 1), true);
});

test('reviewer reconciler is disabled by default and never calls GitHub', async () => {
  const client = new Client();
  const reconciler = new ReviewerReconciler({ config: config({ enabled: false }), client, logger: logger(), metrics: metrics() });
  assert.deepEqual(await reconciler.runOnce(), { skipped: 'disabled' });
  assert.equal(client.calls.length, 0);
});

test('reviewer reconciler holds an explicit request until the exact gate succeeds', async () => {
  const client = new Client({ gate: false });
  const reconciler = new ReviewerReconciler({ config: config(), client, logger: logger(), metrics: metrics() });
  const result = await reconciler.runOnce();
  assert.equal(result.held, 1);
  assert.equal(result.approved, 0);
  assert.equal(client.calls.some((call) => call.method === 'POST'), false);
});

test('reviewer reconciler never approves repositories outside the configured owner policy', async () => {
  const client = new Client({ owner: 'external' });
  const reconciler = new ReviewerReconciler({ config: config({ owner: 'acme' }), client, logger: logger(), metrics: metrics() });
  const result = await reconciler.runOnce();
  assert.equal(result.outsideAllowlist, 1);
  assert.equal(client.calls.some((call) => call.method === 'POST'), false);
});

test('reviewer reconciler records a stale post without treating it as an approval', async () => {
  const client = new Client({ afterHead: 'b'.repeat(40) });
  const reconciler = new ReviewerReconciler({ config: config(), client, logger: logger(), metrics: metrics() });
  const result = await reconciler.runOnce();
  assert.equal(result.stale, 1);
  assert.equal(result.approved, 0);
});
