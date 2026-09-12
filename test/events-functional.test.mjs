import test from 'node:test';
import assert from 'node:assert/strict';

import { routeWebhookEvent } from '../packages/core/src/index.mjs';

function pullRequestPayload(action = 'opened') {
  return {
    action,
    installation: { id: 77 },
    repository: { name: 'repo', owner: { login: 'ORG' } },
    pull_request: { number: 9, head: { sha: 'abc123' } },
    sender: { login: 'alex' },
  };
}

test('webhook routing returns fresh results without mutating the input payload', () => {
  const payload = pullRequestPayload('reopened');
  const before = structuredClone(payload);

  const first = routeWebhookEvent({ event: 'pull_request', payload });
  const second = routeWebhookEvent({ event: 'pull_request', payload });

  assert.deepEqual(payload, before);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.equal(first[0].force, true);
  first[0].force = false;
  first[0].owner = 'MUTATED';
  assert.equal(second[0].force, true);
  assert.equal(second[0].owner, 'ORG');
  assert.deepEqual(payload, before);
});

test('unhandled webhook actions and event families fail closed', () => {
  const payload = pullRequestPayload('synchronize-but-unsupported');
  assert.deepEqual(routeWebhookEvent({ event: 'pull_request', payload }), []);
  assert.deepEqual(routeWebhookEvent({ event: 'deployment', payload }), []);
  assert.deepEqual(routeWebhookEvent({ event: 'check_suite', payload }), []);
});

test('manual review commands are case-insensitive but unrelated comments never route', () => {
  const common = {
    action: 'created',
    installation: { id: 77 },
    repository: { name: 'repo', owner: { login: 'ORG' } },
    issue: { number: 9, pull_request: {} },
    sender: { login: 'alex' },
  };

  const routed = routeWebhookEvent({
    event: 'issue_comment',
    payload: { ...common, comment: { body: '  /ORES-REVIEW gate  ' } },
  });
  assert.equal(routed.length, 1);
  assert.equal(routed[0].type, 'gate');
  assert.equal(routed[0].needsAuthorization, true);

  assert.deepEqual(routeWebhookEvent({
    event: 'issue_comment',
    payload: { ...common, comment: { body: 'please /ores-review gate' } },
  }), []);
});

test('candidate jobs missing routing identity are filtered instead of escaping partially formed', () => {
  const withoutInstallation = pullRequestPayload();
  delete withoutInstallation.installation;
  assert.deepEqual(routeWebhookEvent({ event: 'pull_request', payload: withoutInstallation }), []);

  const externalCheckWithoutRepository = {
    action: 'completed',
    installation: { id: 77 },
    check_run: { name: 'ci/verify', head_sha: 'abc123', pull_requests: [{ number: 9 }] },
  };
  assert.deepEqual(routeWebhookEvent({ event: 'check_run', payload: externalCheckWithoutRepository }), []);
});
