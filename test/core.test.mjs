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
