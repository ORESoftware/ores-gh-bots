import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRulesetPayload,
  ensureInProgressCheck,
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
});

test('check-run update omits create-only head_sha', async () => {
  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (method === 'GET') return { data: { check_runs: [{ id: 9, status: 'in_progress', external_id: 'x' }] } };
      return { data: { id: 9 } };
    },
  };
  await ensureInProgressCheck({ client, token: 't', owner: 'o', repo: 'r', headSha: 'abc', name: CHECK_NAMES.openai, externalId: 'x', summary: 'running' });
  const patch = requests.find((item) => item.method === 'PATCH');
  assert.equal('head_sha' in patch.options.body, false);
});

test('foreign same-name check cannot block creation of an app-owned check', async () => {
  const requests = [];
  const client = {
    async request(method, path, options) {
      requests.push({ method, path, options });
      if (method === 'GET') {
        return { data: { check_runs: [{ id: 9, status: 'in_progress', external_id: 'foreign-review' }] } };
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

test('review annotations are bounded and severity mapped', () => {
  const annotations = reviewAnnotations({ findings: [{ severity: 'high', path: 'a.js', line: 4, title: 'Bug', body: 'Broken', suggestion: null }] });
  assert.equal(annotations[0].annotation_level, 'failure');
  assert.equal(annotations[0].start_line, 4);
});

test('manual command permission requires write or stronger', () => {
  assert.equal(permissionCanTriggerReview('read'), false);
  assert.equal(permissionCanTriggerReview('triage'), false);
  assert.equal(permissionCanTriggerReview('write'), true);
  assert.equal(permissionCanTriggerReview('admin'), true);
});
