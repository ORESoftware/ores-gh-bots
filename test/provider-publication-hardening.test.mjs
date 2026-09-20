import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { Metrics, loadConfig } from '../packages/core/src/index.mjs';

const HEAD = '954fd98aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APPROVED = {
  verdict: 'approve',
  summary: 'Looks correct.',
  confidence: 0.93,
  risk: 'low',
  findings: [],
  tests: [],
  blocking_reasons: [],
};
const JOB = {
  id: 1,
  type: 'review',
  installationId: 1,
  owner: 'O',
  repo: 'R',
  prNumber: 1,
  headSha: HEAD,
  reason: 'publication-hardening-test',
  attempts: 1,
  maxAttempts: 1,
};

function pullRequest() {
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
    head: { ref: 'feature', sha: HEAD },
  };
}

function approvedProviderResponse(url) {
  if (String(url).includes('anthropic')) {
    return Promise.resolve(new Response(JSON.stringify({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'submit_code_review', input: APPROVED }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return Promise.resolve(new Response(JSON.stringify({
    status: 'completed',
    output_text: JSON.stringify(APPROVED),
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

function fakeClient({ failOpenProvider = null, failSuccessCompletionProvider = null } = {}) {
  let checkId = 100;
  let completionFailureUsed = false;
  const calls = [];
  return {
    calls,
    async paginate(path) {
      if (path.includes('/files')) {
        return [{
          filename: 'a.js',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1 +1 @@\n-old\n+new',
        }];
      }
      throw new Error(`Unexpected paginate: ${path}`);
    },
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      if (method === 'GET' && /\/pulls\/1$/.test(path)) return { data: pullRequest() };
      if (method === 'GET' && path.includes('/check-runs?check_name=')) return { data: { check_runs: [] } };
      if (method === 'POST' && path.endsWith('/check-runs')) {
        const provider = options.body.name === 'ores-review/openai'
          ? 'openai'
          : options.body.name === 'ores-review/claude'
            ? 'claude'
            : 'gate';
        if (provider === failOpenProvider) throw Object.assign(new Error(`${provider} check open failed`), { status: 502 });
        return { data: { id: ++checkId, ...options.body } };
      }
      if (method === 'PATCH' && path.includes('/check-runs/')) {
        const provider = options.body.name === 'ores-review/openai'
          ? 'openai'
          : options.body.name === 'ores-review/claude'
            ? 'claude'
            : 'gate';
        if (
          !completionFailureUsed
          && provider === failSuccessCompletionProvider
          && options.body.status === 'completed'
          && options.body.conclusion === 'success'
        ) {
          completionFailureUsed = true;
          throw Object.assign(new Error(`${provider} success check completion failed`), { status: 502 });
        }
        return { data: { id: Number(path.split('/').at(-1)), ...options.body } };
      }
      if (method === 'GET' && path.includes('/check-runs?filter=latest')) return { data: { check_runs: [] } };
      if (method === 'GET' && path.endsWith('/status')) return { data: { statuses: [] } };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function makeEngine(client) {
  const queue = new SqliteQueue({ path: ':memory:' });
  const config = loadConfig({
    OWNER_ALLOWLIST: 'O',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    OPENAI_API_KEY: 'test-openai-key-that-is-not-a-real-secret',
    OPENAI_BASE_URL: 'https://openai.test',
    ANTHROPIC_API_KEY: 'test-anthropic-key-that-is-not-a-real-secret',
    ANTHROPIC_BASE_URL: 'https://anthropic.test',
    GHA_MODE: 'disabled',
  });
  const auth = {
    async repoToken(role) {
      return { installationId: 1, token: `token-${role}` };
    },
  };
  const logger = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {} };
  const engine = new ReviewEngine({
    config,
    client,
    auth,
    queue,
    logger,
    metrics: new Metrics(),
    fetchImpl: approvedProviderResponse,
  });
  return { queue, engine };
}

function storedReviews(queue) {
  return queue.getReviews({ owner: 'O', repo: 'R', prNumber: 1, headSha: HEAD });
}

test('provider approval is not countable when terminal success Check Run publication fails', async () => {
  const client = fakeClient({ failSuccessCompletionProvider: 'openai' });
  const { queue, engine } = makeEngine(client);
  try {
    const result = await engine.process(JOB);
    assert.ok(result.openai.error, 'the provider result is returned as failed publication evidence');
    assert.equal(result.gate.conclusion, 'failure', 'aggregate gate cannot consume the unpublished approval');

    const stored = storedReviews(queue);
    assert.ok(stored.openai.error, 'same-head provider row is overwritten with an error');
    assert.equal(stored.openai.verdict, undefined);
    assert.equal(stored.claude.verdict, 'approve');

    const openaiSuccessPatch = client.calls.find((call) => (
      call.method === 'PATCH'
      && call.options.body.name === 'ores-review/openai'
      && call.options.body.conclusion === 'success'
    ));
    const openaiFailurePatch = client.calls.find((call) => (
      call.method === 'PATCH'
      && call.options.body.name === 'ores-review/openai'
      && call.options.body.conclusion === 'failure'
    ));
    assert.ok(openaiSuccessPatch, 'success publication was attempted');
    assert.ok(openaiFailurePatch, 'failed publication is terminalized best-effort as failure');
  } finally {
    queue.close();
  }
});

test('provider check-open failure invalidates an older same-head approval before gate evaluation', async () => {
  const client = fakeClient({ failOpenProvider: 'openai' });
  const { queue, engine } = makeEngine(client);
  try {
    queue.recordReview({
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      headSha: HEAD,
      provider: 'openai',
      result: APPROVED,
      checkRunId: 77,
    });
    assert.equal(storedReviews(queue).openai.verdict, 'approve', 'negative control seeds stale same-head success');

    const result = await engine.process(JOB);
    assert.ok(result.openai.error);
    assert.equal(result.gate.conclusion, 'failure', 'old same-head success cannot survive a new check-open failure');

    const stored = storedReviews(queue);
    assert.ok(stored.openai.error, 'old success is overwritten with current failure evidence');
    assert.equal(stored.openai.verdict, undefined);
    assert.equal(stored.openai.checkRunId, null);
  } finally {
    queue.close();
  }
});
