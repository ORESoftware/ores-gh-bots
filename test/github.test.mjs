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
      if (method === 'GET') return { data: { check_runs: [{ id: 9, status: 'in_progress' }] } };
      return { data: { id: 9 } };
    },
  };
  await ensureInProgressCheck({ client, token: 't', owner: 'o', repo: 'r', headSha: 'abc', name: CHECK_NAMES.openai, externalId: 'x', summary: 'running' });
  const patch = requests.find((item) => item.method === 'PATCH');
  assert.equal('head_sha' in patch.options.body, false);
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
