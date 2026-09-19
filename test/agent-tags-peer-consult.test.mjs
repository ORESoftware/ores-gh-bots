import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewEngine } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import {
  Metrics,
  attestationVerdict,
  buildReviewAttestations,
  buildReviewEnvelope,
  labelProvider,
  loadConfig,
  parseAgentMarkers,
  peerConsultMode,
  peerConsultPlan,
  reviewTagProviders,
  routeWebhookEvent,
} from '../packages/core/src/index.mjs';

const HEAD = '954fd98aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const approved = { verdict: 'approve', summary: 'Looks correct.', confidence: 0.93, risk: 'low', findings: [], tests: [], blocking_reasons: [] };
const blocked = {
  verdict: 'request_changes', summary: 'Ledger is created outside the lock.', confidence: 0.9, risk: 'high',
  findings: [{ severity: 'high', path: 'a.js', line: 1, title: 'Race', body: 'Two migrators can both create the ledger.', suggestion: null }],
  tests: [], blocking_reasons: ['migration race'],
};

const tag = (fields) => `<!-- ores-agent-tag v1 ${fields} -->\n@codex review\n\nplease`;

test('tag markers addressed to a hosted family select that provider', () => {
  assert.deepEqual(reviewTagProviders(tag(`to=codex from=claude session=s1 kind=review head=${HEAD}`)), ['openai']);
  assert.deepEqual(reviewTagProviders(tag(`to=claude from=codex session=s1 kind=review head=${HEAD}`)), ['claude']);
  assert.deepEqual(reviewTagProviders(tag(`to=cursor from=claude session=s1 kind=review head=${HEAD}`)), []);
  assert.deepEqual(reviewTagProviders(tag(`to=codex from=claude session=s1 kind=merge head=${HEAD}`)), []);
});

test('marker parsing is closed: other versions, malformed fields, and review markers do not request a review', () => {
  assert.deepEqual(parseAgentMarkers('<!-- ores-agent-tag v2 to=codex kind=review -->'), []);
  assert.deepEqual(parseAgentMarkers('<!-- ores-agent-tag v1 to=codex kind=review $(rm) -->'), []);
  assert.deepEqual(parseAgentMarkers(`<!-- ores-agent-tag v1 to=${'x'.repeat(600)} kind=review -->`), []);
  assert.deepEqual(reviewTagProviders(`<!-- ores-agent-review v1 agent=codex session=s head=${HEAD} verdict=approve -->`), []);
  assert.equal(parseAgentMarkers('<!-- ores-agent-tag v1 to=codex kind=review -->'.repeat(40)).length, 16);
});

test('agent-tag labels map to providers', () => {
  assert.equal(labelProvider('agent-tag:codex'), 'openai');
  assert.equal(labelProvider('Agent-Tag:Claude'), 'claude');
  assert.equal(labelProvider('agent-tag:cursor'), null);
  assert.equal(labelProvider('bug'), null);
});

function webhookBase() {
  return { installation: { id: 7 }, repository: { name: 'R', owner: { login: 'O' } }, sender: { login: 'alex' } };
}

test('a tag comment on a pull request routes an authorized forced review', () => {
  const payload = {
    ...webhookBase(), action: 'created', issue: { number: 5, pull_request: {} },
    comment: { body: tag(`to=claude from=codex session=s1 kind=review head=${HEAD}`) },
  };
  const [job] = routeWebhookEvent({ event: 'issue_comment', payload });
  assert.equal(job.type, 'review');
  assert.equal(job.reason, 'issue_comment.agent-tag');
  assert.equal(job.needsAuthorization, true);
  assert.equal(job.sender, 'alex');
  assert.equal(job.headSha, null, 'the marker head is untrusted; the engine re-fetches the live head');
  const onIssue = { ...payload, issue: { number: 5 } };
  assert.deepEqual(routeWebhookEvent({ event: 'issue_comment', payload: onIssue }), []);
});

test('the /ores-review gate command keeps its meaning and a tag mentioning "gate" is still a review', () => {
  const base = { ...webhookBase(), action: 'created', issue: { number: 5, pull_request: {} } };
  assert.equal(routeWebhookEvent({ event: 'issue_comment', payload: { ...base, comment: { body: '/ores-review gate' } } })[0].type, 'gate');
  const body = `${tag(`to=codex from=claude session=s1 kind=review head=${HEAD}`)} under the two-review gate`;
  assert.equal(routeWebhookEvent({ event: 'issue_comment', payload: { ...base, comment: { body } } })[0].type, 'review');
});

test('an agent-tag label routes an authorized review and other labels route nothing', () => {
  const pull_request = { number: 5, head: { sha: HEAD } };
  const labeled = (name) => routeWebhookEvent({ event: 'pull_request', payload: { ...webhookBase(), action: 'labeled', label: { name }, pull_request } });
  const [job] = labeled('agent-tag:codex');
  assert.equal(job.reason, 'pull_request.labeled:agent-tag');
  assert.equal(job.needsAuthorization, true);
  assert.equal(job.headSha, HEAD);
  assert.deepEqual(labeled('bug'), []);
  assert.deepEqual(labeled('agent-tag:cursor'), []);
});

test('attestations bind family, check run, exact head, and a fail-closed verdict', () => {
  assert.equal(attestationVerdict({ verdict: 'comment' }), 'request-changes');
  const lines = buildReviewAttestations({
    headSha: HEAD,
    reviews: { openai: { ...approved, checkRunId: 11 }, claude: { ...blocked, checkRunId: 12 } },
  });
  assert.deepEqual(lines, [
    `<!-- ores-agent-review v1 agent=codex session=ores-gh-bots:openai:11 head=${HEAD} verdict=approve -->`,
    `<!-- ores-agent-review v1 agent=claude session=ores-gh-bots:claude:12 head=${HEAD} verdict=request-changes -->`,
  ]);
  assert.deepEqual(parseAgentMarkers(lines.join('\n')).map((marker) => marker.fields.agent), ['codex', 'claude']);
  assert.deepEqual(buildReviewAttestations({ headSha: 'abc', reviews: { openai: { ...approved, checkRunId: 11 } } }), []);
  assert.deepEqual(buildReviewAttestations({ headSha: HEAD, reviews: { openai: { error: 'boom', checkRunId: 11 }, claude: approved } }), []);
});

test('peer consult plan only ever re-asks a provider that approved', () => {
  assert.throws(() => peerConsultMode('sometimes'));
  assert.equal(peerConsultMode(undefined), 'off');
  const plan = (mode, openai, claude) => peerConsultPlan({ mode, reviews: { openai, claude } }).map((item) => item.provider);
  assert.deepEqual(plan('off', approved, blocked), []);
  assert.deepEqual(plan('disagreement', approved, approved), []);
  assert.deepEqual(plan('disagreement', approved, blocked), ['openai']);
  assert.deepEqual(plan('disagreement', blocked, approved), ['claude']);
  assert.deepEqual(plan('disagreement', blocked, blocked), []);
  assert.deepEqual(plan('always', approved, approved), ['openai', 'claude']);
  assert.deepEqual(plan('always', approved, { error: 'boom' }), []);
});

test('the peer review reaches the prompt only as redacted untrusted data', () => {
  const context = { repository: 'O/R', number: 1, files: [], collection: {} };
  assert.equal('peer_review' in JSON.parse(buildReviewEnvelope(context)), false);
  const envelope = JSON.parse(buildReviewEnvelope({ ...context, peerReview: { reviewer: 'claude', verdict: 'request_changes', summary: 'x' } }));
  assert.equal(envelope.peer_review.reviewer, 'claude');
});

function pullRequest() {
  return {
    number: 1, state: 'open', draft: false, title: 'Test change', body: 'Body', additions: 1, deletions: 0, changed_files: 1,
    user: { login: 'alex' }, base: { ref: 'main', repo: { full_name: 'O/R' } }, head: { ref: 'feature', sha: HEAD },
  };
}

function fakeClient() {
  let checkId = 100;
  const calls = [];
  return {
    calls,
    async paginate(path) {
      if (path.includes('/files')) return [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1 @@\n-old\n+new' }];
      throw new Error(`Unexpected paginate: ${path}`);
    },
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      if (method === 'GET' && /\/pulls\/1$/.test(path)) return { data: pullRequest() };
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

const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const openaiReply = (review) => json({ status: 'completed', output_text: JSON.stringify(review) });
const claudeReply = (review) => json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_code_review', input: review }] });

function engineWith({ env, fetchImpl }) {
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient();
  const config = loadConfig({
    OWNER_ALLOWLIST: 'O', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    OPENAI_API_KEY: 'test-openai-key-that-is-not-a-real-secret', OPENAI_BASE_URL: 'https://openai.test',
    ANTHROPIC_API_KEY: 'test-anthropic-key-that-is-not-a-real-secret', ANTHROPIC_BASE_URL: 'https://anthropic.test',
    GHA_MODE: 'disabled', ...env,
  });
  const auth = { async repoToken(role) { return { installationId: 1, token: `token-${role}` }; } };
  const logger = { child() { return this; }, info() {}, warn() {}, error() {}, debug() {} };
  return { queue, client, engine: new ReviewEngine({ config, client, auth, queue, logger, metrics: new Metrics(), fetchImpl }) };
}

const job = { id: 1, type: 'review', installationId: 1, owner: 'O', repo: 'R', prNumber: 1, headSha: HEAD, reason: 'test', attempts: 1, maxAttempts: 1 };

test('on disagreement the approving provider is invoked with the peer review and can withdraw its approval', async () => {
  const openaiBodies = [];
  let claudeCalls = 0;
  const fetchImpl = (url, init) => {
    if (String(url).includes('anthropic')) { claudeCalls += 1; return claudeReply(blocked); }
    openaiBodies.push(JSON.parse(init.body));
    return openaiReply(openaiBodies.length === 1 ? approved : { ...blocked, summary: 'Confirmed the ledger race.' });
  };
  const { queue, engine } = engineWith({ env: { REVIEW_PEER_CONSULT: 'disagreement' }, fetchImpl });
  try {
    const result = await engine.process(job);
    assert.equal(claudeCalls, 1, 'the provider that blocked is never re-asked');
    assert.equal(openaiBodies.length, 2);
    const independent = JSON.parse(openaiBodies[0].input[1].content[0].text);
    const consulted = JSON.parse(openaiBodies[1].input[1].content[0].text);
    assert.equal('peer_review' in independent, false, 'the first round stays independent');
    assert.equal(consulted.peer_review.reviewer, 'claude');
    assert.equal(consulted.peer_review.findings[0].title, 'Race');
    assert.equal(result.openai.verdict, 'request_changes');
    assert.equal(result.openai.consult, 'withdrawn');
    assert.equal(result.gate.conclusion, 'failure');
    assert.equal(queue.getReviews({ owner: 'O', repo: 'R', prNumber: 1, headSha: HEAD }).openai.verdict, 'request_changes');
  } finally { queue.close(); }
});

test('a consult cannot turn a block into an approval and is off by default', async () => {
  const calls = { openai: 0, claude: 0 };
  const fetchImpl = (url) => {
    if (String(url).includes('anthropic')) { calls.claude += 1; return claudeReply(blocked); }
    calls.openai += 1;
    return openaiReply(approved);
  };
  const upheld = engineWith({ env: { REVIEW_PEER_CONSULT: 'always' }, fetchImpl });
  try {
    const result = await upheld.engine.process(job);
    assert.equal(result.claude.verdict, 'request_changes');
    assert.equal(result.openai.consult, 'upheld');
    assert.equal(result.gate.conclusion, 'failure');
    assert.deepEqual(calls, { openai: 2, claude: 1 });
  } finally { upheld.queue.close(); }

  calls.openai = 0; calls.claude = 0;
  const off = engineWith({ env: {}, fetchImpl });
  try {
    await off.engine.process(job);
    assert.deepEqual(calls, { openai: 1, claude: 1 });
  } finally { off.queue.close(); }
});

test('a failed consult fails that provider closed', async () => {
  let openaiCalls = 0;
  const fetchImpl = (url) => {
    if (String(url).includes('anthropic')) return claudeReply(blocked);
    openaiCalls += 1;
    return openaiCalls === 1 ? openaiReply(approved) : Promise.resolve(new Response('nope', { status: 400 }));
  };
  const { queue, engine } = engineWith({ env: { REVIEW_PEER_CONSULT: 'disagreement' }, fetchImpl });
  try {
    const result = await engine.process(job);
    assert.ok(result.openai.error);
    assert.equal(result.gate.conclusion, 'failure');
  } finally { queue.close(); }
});

test('attestations are published in the head-anchored review only when enabled', async () => {
  const fetchImpl = (url) => (String(url).includes('anthropic') ? claudeReply(approved) : openaiReply(approved));
  const posted = async (env) => {
    const { queue, client, engine } = engineWith({ env, fetchImpl });
    try {
      await engine.process(job);
      return client.calls.find((call) => call.method === 'POST' && call.path.endsWith('/reviews'))?.options.body;
    } finally { queue.close(); }
  };
  const body = await posted({ POST_PULL_REQUEST_REVIEW: 'true', REVIEW_AGENT_ATTESTATIONS: 'true' });
  assert.equal(body.commit_id, HEAD);
  assert.equal(body.event, 'COMMENT');
  assert.deepEqual(parseAgentMarkers(body.body).map((marker) => `${marker.fields.agent}:${marker.fields.verdict}:${marker.fields.head}`), [
    `codex:approve:${HEAD}`, `claude:approve:${HEAD}`,
  ]);
  const plain = await posted({ POST_PULL_REQUEST_REVIEW: 'true' });
  assert.deepEqual(parseAgentMarkers(plain.body), []);
  assert.equal(await posted({ REVIEW_AGENT_ATTESTATIONS: 'true' }), undefined);
});
