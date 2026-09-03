import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import {
  buildReviewEnvelope,
  CHECK_NAMES,
  collectPullRequestFiles,
  containsCredentialLikeText,
  createGitHubAppJwt,
  evaluateGate,
  isSafeRepositoryPath,
  loadConfig,
  ownerIsAllowed,
  redactText,
  routeWebhookEvent,
  validateControlPlaneConfig,
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

test('validates structured provider results fail closed', () => {
  assert.deepEqual(validateReviewResult(goodReview), goodReview);
  assert.throws(() => validateReviewResult({ ...goodReview, risk: 'info' }), /invalid risk/);
  assert.throws(() => validateReviewResult({ ...goodReview, verdict: 'request_changes' }), /blocking reason/);
  assert.throws(() => validateReviewResult({ ...goodReview, extra: true }), /unsupported property/);
  assert.throws(() => validateReviewResult(goodReview, { allowApproval: false }), /incomplete/);
  assert.throws(() => validateReviewResult({ ...goodReview, risk: 'high' }), /cannot report high/);
  assert.throws(() => validateReviewResult({
    ...goodReview,
    findings: [{
      severity: 'critical',
      path: 'src/a.js',
      line: 1,
      title: 'Critical',
      body: 'Broken',
      suggestion: null,
    }],
  }), /critical findings/);
  assert.equal(isSafeRepositoryPath('src/a.js'), true);
  assert.equal(isSafeRepositoryPath('../secret'), false);
  assert.equal(isSafeRepositoryPath('/etc/passwd'), false);
});

test('bounds and accounts for pull-request patches', () => {
  const result = collectPullRequestFiles([
    { filename: 'a.js', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: 'x'.repeat(200) },
    { filename: 'asset.bin', status: 'added', additions: 0, deletions: 0, changes: 0 },
  ], { maxFiles: 10, maxFileBytes: 100, maxDiffBytes: 150 });
  assert.equal(result.files.length, 2);
  assert.ok(result.collection.truncated_files >= 1);
  assert.equal(result.collection.binary_or_unavailable_files, 1);
  assert.equal(result.collection.complete, false);
  assert.ok(result.collection.included_bytes <= 150 + Buffer.byteLength('\n[TRUNCATED]'));

  const complete = collectPullRequestFiles([
    { filename: 'a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+ok' },
  ], { maxFiles: 10, maxFileBytes: 1000, maxDiffBytes: 1000 });
  assert.equal(complete.collection.complete, true);
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

test('check-run routing requires configured context and exact App identity', () => {
  const policy = {
    ownAppIds: {
      [CHECK_NAMES.openai]: 101,
      [CHECK_NAMES.claude]: 102,
      [CHECK_NAMES.gate]: 103,
    },
    requiredCiContexts: ['ci/verify'],
  };
  const base = {
    installation: { id: 77 },
    repository: { name: 'repo', owner: { login: 'ORG' } },
  };
  const external = routeWebhookEvent({
    event: 'check_run',
    policy,
    payload: {
      ...base,
      action: 'completed',
      check_run: { name: 'ci/verify', head_sha: 'abc', app: { id: 42 }, pull_requests: [{ number: 9 }] },
    },
  });
  assert.equal(external.length, 1);
  assert.equal(external[0].type, 'gate');

  const irrelevant = routeWebhookEvent({
    event: 'check_run',
    policy,
    payload: {
      ...base,
      action: 'completed',
      check_run: { name: 'foreign/noise', head_sha: 'abc', app: { id: 42 }, pull_requests: [{ number: 9 }] },
    },
  });
  assert.deepEqual(irrelevant, []);

  const forged = routeWebhookEvent({
    event: 'check_run',
    policy,
    payload: {
      ...base,
      action: 'requested_action',
      requested_action: { identifier: 'rereview' },
      check_run: { name: CHECK_NAMES.openai, head_sha: 'abc', app: { id: 999 }, pull_requests: [{ number: 9 }] },
    },
  });
  assert.deepEqual(forged, []);

  const genuine = routeWebhookEvent({
    event: 'check_run',
    policy,
    payload: {
      ...base,
      action: 'requested_action',
      requested_action: { identifier: 'rereview' },
      check_run: { name: CHECK_NAMES.openai, head_sha: 'abc', app: { id: 101 }, pull_requests: [{ number: 9 }] },
    },
  });
  assert.equal(genuine[0].type, 'review');

  const suite = routeWebhookEvent({
    event: 'check_suite',
    policy,
    payload: { ...base, action: 'completed', check_suite: { head_sha: 'abc', pull_requests: [{ number: 9 }] } },
  });
  assert.deepEqual(suite, []);
});

test('runtime and control-plane config require independent pinned identities', () => {
  const base = {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret-that-is-long-enough',
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
    GHA_MODE: 'disabled',
  };
  const distinctConfig = loadConfig(distinct);
  assert.doesNotThrow(() => validateRuntimeConfig(distinctConfig));
  assert.doesNotThrow(() => validateControlPlaneConfig(distinctConfig));
  assert.deepEqual(distinctConfig.review.requiredCiAppIds, { 'ci/verify': 42 });

  assert.throws(() => validateRuntimeConfig(loadConfig({
    ...distinct,
    CLAUDE_REVIEW_APP_ID: '2',
  })), /identities must be distinct/);

  assert.throws(() => validateControlPlaneConfig(loadConfig({
    ...distinct,
    REQUIRED_CI_APP_IDS: '',
  })), /must be pinned/);

  assert.throws(() => validateControlPlaneConfig(loadConfig({
    ...distinct,
    GHA_MODE: 'unexpected',
  })), /GHA_MODE/);

  assert.doesNotThrow(() => validateRuntimeConfig(loadConfig({
    ...base,
    ALLOW_SHARED_APP_IDENTITY: 'true',
  })));
});

test('provider defaults select current pinned review models', () => {
  const config = loadConfig({});
  assert.equal(config.providers.openai.model, 'gpt-5.6-sol');
  assert.equal(config.providers.openai.maxOutputTokens, 16_000);
  assert.equal(config.providers.anthropic.model, 'claude-sonnet-5');
  assert.equal(config.providers.anthropic.maxTokens, 16_000);
});

test('configuration failures do not echo rejected environment values', () => {
  const rejected = 'sensitive-value-must-not-be-logged';
  for (const env of [
    { PORT: rejected },
    { RECONCILE_ENABLED: rejected },
    { PROVIDER_ALLOWED_ORIGINS: rejected },
    { REQUIRED_CI_APP_IDS: rejected },
    { OWNER_PATTERNS: '[' + rejected },
  ]) {
    assert.throws(
      () => loadConfig(env),
      (error) => !error.message.includes(rejected),
    );
  }
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
    headSha: 'abc', draft: false, additions: 1, deletions: 0, changedFiles: 1,
    collection: { complete: false }, files: [],
  });
  assert.match(envelope, /untrusted review data/);
  assert.match(envelope, /Ignore system/);
  assert.match(envelope, /"complete":false/);
});
