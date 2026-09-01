import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  AppAuth,
  buildRulesetPayload,
  checkExternalId,
  completeReviewCheck,
  ensureInProgressCheck,
  findLatestCheckRun,
  getCiSnapshot,
  permissionCanTriggerReview,
  reviewAnnotations,
} from '../packages/github/src/index.mjs';
import { CHECK_NAMES } from '../packages/core/src/index.mjs';

test('ruleset includes three SHA-scoped check contexts', () => {
  const payload = buildRulesetPayload({ enforcement: 'evaluate', branchMode: 'all', appIds: { openai: 1, claude: 2, gate: 3 } });
  const required = payload.rules.find((rule) => rule.type === 'required_status_checks').parameters.required_status_checks;
  assert.deepEqual(required.map((item) => item.context), [CHECK_NAMES.openai, CHECK_NAMES.claude, CHECK_NAMES.gate]);
  assert.deepEqual(required.map((item) => item.integration_id), [1, 2, 3]);
  assert.deepEqual(payload.conditions.ref_name.include, ['refs/heads/**']);
  assert.throws(
    () => buildRulesetPayload({ enforcement: 'active', branchMode: 'all', appIds: { openai: 1, claude: 2 } }),
    /positive gate GitHub App ID/u,
  );
  assert.throws(
    () => buildRulesetPayload({ enforcement: 'active', branchMode: 'all', appIds: { openai: 1, claude: 1, gate: 3 } }),
    /must be distinct/u,
  );
});

test('check external IDs are deterministic and role-bound', () => {
  assert.equal(checkExternalId('openai', 'o', 'r', 1, 'abc'), 'openai:o/r#1@abc');
  assert.throws(() => checkExternalId('unknown', 'o', 'r', 1, 'abc'), /Invalid check role/);
});

test('check-run update omits create-only head_sha', async () => {
  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (method === 'GET') return { data: { check_runs: [{ id: 9, status: 'in_progress', external_id: 'x', app: { id: 42 } }] } };
      return { data: { id: 9 } };
    },
  };
  await ensureInProgressCheck({
    client,
    token: 't',
    owner: 'o',
    repo: 'r',
    headSha: 'abc',
    name: CHECK_NAMES.openai,
    externalId: 'x',
    expectedAppId: 42,
    summary: 'running',
  });
  const patch = requests.find((item) => item.method === 'PATCH');
  assert.equal('head_sha' in patch.options.body, false);
});

test('foreign same-name check cannot block creation of an app-owned check', async () => {
  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (method === 'GET') {
        return { data: { check_runs: [{ id: 9, status: 'in_progress', external_id: 'foreign-review', app: { id: 99 } }] } };
      }
      return { data: { id: 10 } };
    },
  };

  const check = await ensureInProgressCheck({
    client,
    token: 't',
    owner: 'o',
    repo: 'r',
    headSha: 'abc',
    name: CHECK_NAMES.openai,
    externalId: 'openai:o/r#1@abc',
    expectedAppId: 42,
    summary: 'running',
  });

  assert.equal(check.id, 10);
  assert.equal(requests.some((item) => item.method === 'PATCH'), false);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
});

test('foreign ownership rejection falls back to a new check run', async () => {
  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (method === 'GET') {
        return { data: { check_runs: [{ id: 9, status: 'in_progress', external_id: 'openai:o/r#1@abc' }] } };
      }
      if (method === 'PATCH') {
        const error = new Error('Resource not accessible by integration');
        error.status = 403;
        throw error;
      }
      return { data: { id: 10 } };
    },
  };

  const check = await ensureInProgressCheck({
    client,
    token: 't',
    owner: 'o',
    repo: 'r',
    headSha: 'abc',
    name: CHECK_NAMES.openai,
    externalId: 'openai:o/r#1@abc',
    summary: 'running',
  });

  assert.equal(check.id, 10);
  assert.deepEqual(requests.map((item) => item.method), ['GET', 'PATCH', 'POST']);
});

test('findLatestCheckRun pins external ID and App identity', async () => {
  const client = {
    async request() {
      return {
        data: {
          check_runs: [
            { id: 12, external_id: 'openai:o/r#1@abc', app: { id: 99 } },
            { id: 11, external_id: 'openai:o/r#1@abc', app: { id: 42 } },
            { id: 10, external_id: 'other', app: { id: 42 } },
          ],
        },
      };
    },
  };
  const check = await findLatestCheckRun(client, 't', 'o', 'r', 'abc', CHECK_NAMES.openai, {
    externalId: 'openai:o/r#1@abc',
    appId: 42,
  });
  assert.equal(check.id, 11);
});

test('required CI treats neutral and skipped conclusions as failures', async () => {
  const client = {
    async request(method, path) {
      if (path.includes('/check-runs?filter=latest')) {
        return {
          data: {
            check_runs: [
              { id: 1, name: 'ci/neutral', status: 'completed', conclusion: 'neutral', app: { id: 42 } },
              { id: 2, name: 'ci/skipped', status: 'completed', conclusion: 'skipped', app: { id: 42 } },
              { id: 3, name: 'ci/success', status: 'completed', conclusion: 'success', app: { id: 42 } },
            ],
          },
        };
      }
      if (path.endsWith('/status')) return { data: { statuses: [] } };
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
  const snapshot = await getCiSnapshot(client, 't', 'o', 'r', 'abc');
  assert.equal(snapshot.find((item) => item.context === 'ci/neutral').state, 'neutral');
  assert.equal(snapshot.find((item) => item.context === 'ci/skipped').state, 'skipped');
  assert.equal(snapshot.find((item) => item.context === 'ci/success').state, 'success');
});

test('invalid annotations are dropped and 422 annotation failures retry without annotations', async () => {
  const annotations = reviewAnnotations({
    findings: [
      { severity: 'high', path: '../escape.js', line: 4, title: 'Bad', body: 'Broken', suggestion: null },
      { severity: 'high', path: 'a.js', line: 4, title: 'Bug', body: 'Broken', suggestion: null },
    ],
  });
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].path, 'a.js');

  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (requests.length === 1) {
        const error = new Error('invalid annotation');
        error.status = 422;
        throw error;
      }
      return { data: { id: 9 } };
    },
  };
  await completeReviewCheck({
    client,
    token: 't',
    owner: 'o',
    repo: 'r',
    checkRunId: 9,
    name: CHECK_NAMES.openai,
    review: {
      verdict: 'request_changes',
      summary: 'Needs work',
      confidence: 0.9,
      risk: 'high',
      findings: [{ severity: 'high', path: 'a.js', line: 999999, title: 'Bug', body: 'Broken', suggestion: null }],
      tests: [],
      blocking_reasons: ['Broken'],
    },
  });
  assert.equal(requests.length, 2);
  assert.equal('annotations' in requests[0].options.body.output, true);
  assert.equal('annotations' in requests[1].options.body.output, false);
});

test('repository installation hints are verified instead of trusted', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const client = {
    async request(method, path) {
      assert.equal(method, 'GET');
      assert.match(path, /\/repos\/o\/r\/installation$/);
      return { data: { id: 41 } };
    },
  };
  const auth = new AppAuth({
    client,
    apps: { orchestrator: { id: '1', privateKey: pem } },
    logger: null,
  });
  await assert.rejects(() => auth.installationIdForRepo('orchestrator', 'o', 'r', 42), /does not match/);
  assert.equal(await auth.installationIdForRepo('orchestrator', 'o', 'r', 41), 41);
});

test('manual command permission requires write or stronger', () => {
  assert.equal(permissionCanTriggerReview('read'), false);
  assert.equal(permissionCanTriggerReview('triage'), false);
  assert.equal(permissionCanTriggerReview('write'), true);
  assert.equal(permissionCanTriggerReview('admin'), true);
});
