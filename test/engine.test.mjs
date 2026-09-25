import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { loadConfig, Metrics } from '../packages/core/src/index.mjs';

const HEAD = 'a'.repeat(40);
const approved = {
  verdict: 'approve', summary: 'Looks correct.', confidence: 0.93, risk: 'low', findings: [], tests: [], blocking_reasons: [],
};

function pullRequest(sha = HEAD) {
  return {
    number: 1,
    state: 'open',
    draft: false,
    title: 'Test change',
    body: 'Body',
    additions: 1,
    deletions: 0,
    changed_files: 1,
    user: { login: 'alex' },
    base: { ref: 'main', repo: { full_name: 'O/R' } },
    head: { ref: 'feature', sha },
  };
}

function fakeClient({ currentSha = HEAD } = {}) {
  let checkId = 100;
  const calls = [];
  return {
    calls,
    async paginate(path) {
      calls.push({ method: 'PAGINATE', path });
      if (path.includes('/files')) return [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
      throw new Error(`Unexpected paginate: ${path}`);
    },
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      if (method === 'GET' && /\/pulls\/1$/.test(path)) return { data: pullRequest(currentSha) };
      if (method === 'GET' && path.includes('/check-runs?check_name=')) return { data: { check_runs: [] } };
      if (method === 'POST' && path.endsWith('/check-runs')) return { data: { id: ++checkId, ...options.body } };
      if (method === 'PATCH' && path.includes('/check-runs/')) return { data: { id: Number(path.split('/').at(-1)), ...options.body } };
      if (method === 'GET' && path.includes('/check-runs?filter=latest')) return { data: { check_runs: [] } };
      if (method === 'GET' && path.endsWith('/status')) return { data: { statuses: [] } };
      if (method === 'POST' && path.endsWith('/reviews')) return { data: { id: 1 } };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function providerFetch(url) {
  if (String(url).includes('openai')) {
    return Promise.resolve(new Response(JSON.stringify({ status: 'completed', model: 'gpt-6-astra', output_text: JSON.stringify(approved) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  if (String(url).includes('anthropic')) {
    return Promise.resolve(new Response(JSON.stringify({ model: 'claude-fable-5-1', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_code_review', input: approved }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  throw new Error(`Unexpected provider URL: ${url}`);
}

function config() {
  return loadConfig({
    OWNER_ALLOWLIST: 'O',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    OPENAI_REVIEW_APP_ID: '2',
    CLAUDE_REVIEW_APP_ID: '3',
    GATE_APP_ID: '4',
    OPENAI_API_KEY: 'test-openai-key-that-is-not-a-real-secret',
    OPENAI_BASE_URL: 'https://openai.test',
    ANTHROPIC_API_KEY: 'test-anthropic-key-that-is-not-a-real-secret',
    ANTHROPIC_BASE_URL: 'https://anthropic.test',
    GHA_MODE: 'disabled',
    POST_PULL_REQUEST_REVIEW: 'false',
  });
}

const auth = {
  async repoToken(role) { return { installationId: 1, token: `token-${role}` }; },
};

const silentLogger = {
  child() { return this; }, info() {}, warn() {}, error() {}, debug() {},
};

test('engine publishes two approvals and a successful exact-SHA gate', async () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient();
  const engine = new ReviewEngine({ config: config(), client, auth, queue, logger: silentLogger, metrics: new Metrics(), fetchImpl: providerFetch });
  try {
    const result = await engine.process({
      id: 1, type: 'review', installationId: 1, owner: 'O', repo: 'R', prNumber: 1, headSha: HEAD, reason: 'test',
      attempts: 1, maxAttempts: 1,
    });
    assert.equal(result.openai.verdict, 'approve');
    assert.equal(result.claude.verdict, 'approve');
    assert.equal(result.gate.conclusion, 'success');
    assert.equal(result.gate.headSha, HEAD);
    const creates = client.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/check-runs'));
    assert.equal(creates.length, 3);
    assert.deepEqual(creates.map((call) => call.options.body.name).sort(), ['ores-review/claude', 'ores-review/gate', 'ores-review/openai']);
  } finally { queue.close(); }
});

test('engine refuses to review a stale queued SHA and enqueues the current SHA', async () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient({ currentSha: 'b'.repeat(40) });
  const engine = new ReviewEngine({ config: config(), client, auth, queue, logger: silentLogger, metrics: new Metrics(), fetchImpl: providerFetch });
  try {
    const result = await engine.process({
      id: 1, type: 'review', installationId: 1, owner: 'O', repo: 'R', prNumber: 1, headSha: 'c'.repeat(40), reason: 'test',
      attempts: 1, maxAttempts: 1,
    });
    assert.equal(result.skipped, 'stale-head');
    const replacement = queue.claimNext('worker', 30_000);
    assert.equal(replacement.headSha, 'b'.repeat(40));
    assert.equal(client.calls.some((call) => call.method === 'POST' && call.path.endsWith('/check-runs')), false);
  } finally { queue.close(); }
});
