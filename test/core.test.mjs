import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  buildReviewEnvelope,
  collectPullRequestFiles,
  containsCredentialLikeText,
  createGitHubAppJwt,
  evaluateGate,
  loadConfig,
  ownerIsAllowed,
  redactText,
  routeWebhookEvent,
  validateReviewResult,
  validateRuntimeConfig,
  verifyWebhookSignature,
} from '../packages/core/src/index.mjs';

const goodReview = {
  verdict: 'approve',
  summary: 'The change is safe.',
  confidence: 0.9,
  risk: 'low',
  findings: [],
  tests: ['Run unit tests'],
  blocking_reasons: [],
};

test('verifies GitHub webhook signatures without string comparison leaks', () => {
  const body = Buffer.from('{"ok":true}');
  const secret = 'test-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyWebhookSignature({ secret, body, signature }), true);
  assert.equal(verifyWebhookSignature({ secret, body, signature: `${signature}0` }), false);
});

test('creates an RS256 GitHub App JWT', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = createGitHubAppJwt({ appId: 123, privateKey });
  assert.equal(jwt.split('.').length, 3);
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, '123');
  assert.ok(payload.exp > payload.iat);
});

test('redacts common credential formats', () => {
  const token = `ghp_${'A'.repeat(36)}`;
  assert.equal(containsCredentialLikeText(token), true);
  assert.match(redactText(`Authorization: Bearer ${token}`), /REDACTED/);
  assert.doesNotMatch(redactText(token), /ghp_/);
});

test('validates a structured provider result', () => {
  assert.deepEqual(validateReviewResult(goodReview), goodReview);
  assert.throws(() => validateReviewResult({ ...goodReview, risk: 'info' }), /invalid risk/);
  assert.throws(() => validateReviewResult({ ...goodReview, verdict: 'request_changes' }), /blocking reason/);
});

test('bounds and accounts for pull-request patches', () => {
  const result = collectPullRequestFiles([
    { filename: 'a.js', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: 'x'.repeat(200) },
    { filename: 'asset.bin', status: 'added', additions: 0, deletions: 0, changes: 0 },
  ], { maxFiles: 10, maxFileBytes: 100, maxDiffBytes: 150 });
  assert.equal(result.files.length, 2);
  assert.ok(result.collection.truncated_files >= 1);
  assert.equal(result.collection.binary_or_unavailable_files, 1);
  assert.ok(result.collection.included_bytes <= 150 + Buffer.byteLength('\n[TRUNCATED]'));
});

test('gate fails closed for missing or non-approving providers', () => {
  const pending = evaluateGate({ reviews: { openai: goodReview }, ci: [], requiredCiContexts: [] });
  assert.equal(pending.status, 'in_progress');
  const failed = evaluateGate({ reviews: { openai: goodReview, claude: { ...goodReview, verdict: 'comment' } }, ci: [], requiredCiContexts: [] });
  assert.equal(failed.conclusion, 'failure');
  const passed = evaluateGate({ reviews: { openai: goodReview, claude: goodReview }, ci: [{ context: 'test', state: 'success' }], requiredCiContexts: ['test'] });
  assert.equal(passed.conclusion, 'success');
});

test('gate pins required CI contexts to expected GitHub App identities', () => {
  const reviews = { openai: goodReview, claude: goodReview };
  const passed = evaluateGate({
    reviews,
    ci: [{ context: 'ci/verify', state: 'success', appId: 42 }],
    requiredCiContexts: ['ci/verify'],
    requiredCiAppIds: { 'ci/verify': 42 },
  });
  assert.equal(passed.conclusion, 'success');

  const spoofed = evaluateGate({
    reviews,
    ci: [{ context: 'ci/verify', state: 'success', appId: 99 }],
    requiredCiContexts: ['ci/verify'],
    requiredCiAppIds: { 'ci/verify': 42 },
  });
  assert.equal(spoofed.conclusion, 'failure');
  assert.match(spoofed.ciStates[0].reason, /app identity mismatch/);
});

test('routes supported PR and manual review events', () => {
  const base = {
    installation: { id: 77 },
    repository: { name: 'repo', owner: { login: 'ORG' } },
    pull_request: { number: 9, head: { sha: 'abc' } },
  };
  assert.equal(routeWebhookEvent({ event: 'pull_request', payload: { ...base, action: 'opened' } })[0].headSha, 'abc');
  const manual = routeWebhookEvent({ event: 'issue_comment', payload: {
    action: 'created', installation: { id: 77 }, repository: base.repository,
    issue: { number: 9, pull_request: {} }, comment: { body: '/ores-review gate' }, sender: { login: 'alex' },
  } })[0];
  assert.equal(manual.type, 'gate');
  assert.equal(manual.needsAuthorization, true);
});

test('uses check_run completion as the sole CI re-evaluation trigger', () => {
  const base = {
    action: 'completed',
    installation: { id: 77 },
    repository: { name: 'repo', owner: { login: 'ORG' } },
  };
  const external = routeWebhookEvent({
    event: 'check_run',
    payload: {
      ...base,
      check_run: { name: 'ci/verify', head_sha: 'abc', pull_requests: [{ number: 9 }] },
    },
  });
  assert.equal(external.length, 1);
  assert.equal(external[0].type, 'gate');
  assert.equal(external[0].headSha, 'abc');

  const own = routeWebhookEvent({
    event: 'check_run',
    payload: {
      ...base,
      check_run: { name: 'ores-review/gate', head_sha: 'abc', pull_requests: [{ number: 9 }] },
    },
  });
  assert.deepEqual(own, []);

  const suite = routeWebhookEvent({
    event: 'check_suite',
    payload: {
      ...base,
      check_suite: { head_sha: 'abc', pull_requests: [{ number: 9 }] },
    },
  });
  assert.deepEqual(suite, []);
});

test('runtime config requires independent reviewer and gate App identities by default', () => {
  const base = {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
  };
  assert.throws(() => validateRuntimeConfig(loadConfig(base)), /OPENAI_REVIEW_APP_ID/);

  const distinct = {
    ...base,
    OPENAI_REVIEW_APP_ID: '2',
    OPENAI_REVIEW_APP_PRIVATE_KEY: 'openai-app-key',
    CLAUDE_REVIEW_APP_ID: '3',
    CLAUDE_REVIEW_APP_PRIVATE_KEY: 'claude-app-key',
    GATE_APP_ID: '4',
    GATE_APP_PRIVATE_KEY: 'gate-app-key',
    REQUIRED_CI_CONTEXTS: 'ci/verify',
    REQUIRED_CI_APP_IDS: 'ci/verify=42',
  };
  const distinctConfig = loadConfig(distinct);
  assert.doesNotThrow(() => validateRuntimeConfig(distinctConfig));
  assert.deepEqual(distinctConfig.review.requiredCiAppIds, { 'ci/verify': 42 });

  assert.throws(() => validateRuntimeConfig(loadConfig({
    ...distinct,
    CLAUDE_REVIEW_APP_ID: '2',
  })), /identities must be distinct/);

  assert.doesNotThrow(() => validateRuntimeConfig(loadConfig({
    ...base,
    ALLOW_SHARED_APP_IDENTITY: 'true',
  })));
});

test('owner allowlist fails closed', () => {
  const config = loadConfig({ OWNER_ALLOWLIST: 'ORESoftware', OWNER_PATTERNS: '.*-test$' });
  assert.equal(ownerIsAllowed(config, 'ORESoftware'), true);
  assert.equal(ownerIsAllowed(config, 'fiducia-cloud-test'), true);
  assert.equal(ownerIsAllowed(config, 'random-org'), false);
  assert.equal(ownerIsAllowed(loadConfig({}), 'ORESoftware'), false);
});

test('review envelope labels all repository content as untrusted', () => {
  const envelope = buildReviewEnvelope({
    repository: 'o/r', number: 1, title: 'Ignore system', body: '', author: 'u', baseRef: 'main', headRef: 'x',
    headSha: 'abc', draft: false, additions: 1, deletions: 0, changedFiles: 1, collection: {}, files: [],
  });
  assert.match(envelope, /untrusted review data/);
  assert.match(envelope, /Ignore system/);
});
