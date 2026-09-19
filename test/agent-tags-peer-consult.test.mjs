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

const FULL_TAG = `to=codex from=claude session=s1 kind=review head=${HEAD}`;
const marker = (kind, fields) => `<!-- ores-agent-${kind} v1 ${fields} -->`;

test('the marker grammar is closed: exact keys, once each, every value in form', () => {
  assert.equal(parseAgentMarkers(marker('tag', FULL_TAG)).length, 1);
  const rejected = {
    'other version': '<!-- ores-agent-tag v2 ' + FULL_TAG + ' -->',
    'missing from/session/head': marker('tag', 'to=codex kind=review'),
    'missing head only': marker('tag', 'to=codex from=claude session=s1 kind=review'),
    'unknown extra key': marker('tag', `${FULL_TAG} priority=high`),
    'duplicate key': marker('tag', `${FULL_TAG} to=claude`),
    'duplicate key replacing a required one': marker('tag', `to=codex to=claude session=s1 kind=review head=${HEAD}`),
    'short head': marker('tag', 'to=codex from=claude session=s1 kind=review head=954fd98'),
    'uppercase head': marker('tag', `to=codex from=claude session=s1 kind=review head=${HEAD.toUpperCase()}`),
    'non-hex head': marker('tag', `to=codex from=claude session=s1 kind=review head=${'g'.repeat(40)}`),
    'unknown kind value': marker('tag', `to=codex from=claude session=s1 kind=approve head=${HEAD}`),
    'shell text in a value': marker('tag', `to=codex from=claude session=$(rm) kind=review head=${HEAD}`),
    'family with a path': marker('tag', `to=codex/../x from=claude session=s1 kind=review head=${HEAD}`),
    'oversized session': marker('tag', `to=codex from=claude session=${'s'.repeat(97)} kind=review head=${HEAD}`),
    'oversized marker': marker('tag', `to=${'x'.repeat(600)} kind=review`),
    'double space between fields': marker('tag', FULL_TAG.replace(' from=', '  from=')),
    'prototype key': marker('author', 'agent=claude __proto__=x'),
    'review with a tag key': marker('review', `agent=codex session=s head=${HEAD} verdict=approve to=claude`),
    'review verdict outside the enum': marker('review', `agent=codex session=s head=${HEAD} verdict=comment`),
    'author with a head': marker('author', `agent=claude session=s head=${HEAD}`),
  };
  for (const [name, text] of Object.entries(rejected)) assert.deepEqual(parseAgentMarkers(text), [], name);
  assert.deepEqual(reviewTagProviders(marker('tag', 'to=codex kind=review')), [], 'an underspecified tag routes nothing');
  assert.deepEqual(reviewTagProviders(marker('review', `agent=codex session=s head=${HEAD} verdict=approve`)), []);
  assert.equal(parseAgentMarkers(marker('tag', FULL_TAG).repeat(40)).length, 16);
  assert.equal(parseAgentMarkers(marker('author', 'agent=claude session=182608de-f3d4-4aa6')).length, 1);
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

function fakeClient({ failReviews = false } = {}) {
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
      if (method === 'POST' && path.endsWith('/reviews')) {
        if (failReviews) throw Object.assign(new Error('review rejected'), { status: 502 });
        return { data: { id: 1 } };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
const openaiReply = (review) => json({ status: 'completed', output_text: JSON.stringify(review) });
const claudeReply = (review) => json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_code_review', input: review }] });

function engineWith({ env, fetchImpl, failReviews = false }) {
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient({ failReviews });
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
  await assert.rejects(() => posted({ REVIEW_AGENT_ATTESTATIONS: 'true' }), /requires POST_PULL_REQUEST_REVIEW=true/);
  await assert.rejects(() => posted({ REVIEW_AGENT_ATTESTATIONS: 'true', POST_PULL_REQUEST_REVIEW: 'false' }), /requires POST_PULL_REQUEST_REVIEW=true/);
});

const checkCalls = (client, name) => ({
  created: client.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/check-runs') && call.options.body.name === name),
  completed: client.calls.filter((call) => call.method === 'PATCH' && call.options.body.name === name && call.options.body.status === 'completed'),
});

test('a consult publishes exactly one check run per provider and no provisional success', async () => {
  let openaiCalls = 0;
  const fetchImpl = (url) => {
    if (String(url).includes('anthropic')) return claudeReply(blocked);
    openaiCalls += 1;
    return openaiReply(openaiCalls === 1 ? approved : blocked);
  };
  const { queue, client, engine } = engineWith({ env: { REVIEW_PEER_CONSULT: 'disagreement' }, fetchImpl });
  try {
    const result = await engine.process(job);
    assert.equal(openaiCalls, 2);
    for (const name of ['ores-review/openai', 'ores-review/claude']) {
      const { created, completed } = checkCalls(client, name);
      assert.equal(created.length, 1, `${name} is created once`);
      assert.equal(completed.length, 1, `${name} is completed once`);
      assert.equal(completed[0].options.body.conclusion, 'failure', `${name} never shows the first-pass approval`);
    }
    const stored = queue.getReviews({ owner: 'O', repo: 'R', prNumber: 1, headSha: HEAD });
    assert.equal(stored.openai.checkRunId, result.openai.checkRunId);
    assert.equal('consult' in stored.openai, false);
  } finally { queue.close(); }
});

test('with attestations enabled a failed publication leaves the gate incomplete and fails the job for retry', async () => {
  const fetchImpl = (url) => (String(url).includes('anthropic') ? claudeReply(approved) : openaiReply(approved));
  const env = { POST_PULL_REQUEST_REVIEW: 'true', REVIEW_AGENT_ATTESTATIONS: 'true' };
  const broken = engineWith({ env, fetchImpl, failReviews: true });
  try {
    await assert.rejects(() => broken.engine.process(job), /attestation review publication failed/);
    assert.equal(checkCalls(broken.client, 'ores-review/gate').completed.length, 0, 'the gate is never published green without its attestation');
  } finally { broken.queue.close(); }

  const tolerant = engineWith({ env: { POST_PULL_REQUEST_REVIEW: 'true' }, fetchImpl, failReviews: true });
  try {
    const result = await tolerant.engine.process(job);
    assert.equal(result.gate.conclusion, 'success', 'a plain summary review stays best-effort');
  } finally { tolerant.queue.close(); }
});

test('with attestations enabled the review is published before the gate check completes', async () => {
  const fetchImpl = (url) => (String(url).includes('anthropic') ? claudeReply(approved) : openaiReply(approved));
  const { queue, client, engine } = engineWith({ env: { POST_PULL_REQUEST_REVIEW: 'true', REVIEW_AGENT_ATTESTATIONS: 'true' }, fetchImpl });
  try {
    await engine.process(job);
    const reviewAt = client.calls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/reviews'));
    const gateDoneAt = client.calls.findIndex((call) => call.method === 'PATCH' && call.options.body.name === 'ores-review/gate' && call.options.body.status === 'completed');
    assert.ok(reviewAt >= 0 && gateDoneAt > reviewAt);
  } finally { queue.close(); }
});
