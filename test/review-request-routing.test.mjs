import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWebhookEvent } from '../packages/core/src/events.mjs';

function payload(action = 'review_requested') {
  return {
    action,
    installation: { id: 77 },
    repository: { name: 'ores-gh-bots', owner: { login: 'ORESoftware' } },
    pull_request: { number: 55, head: { sha: 'a'.repeat(40) } },
    requested_reviewer: { login: 'the1mills' },
  };
}

test('late pull_request.review_requested queues only an exact-head forced gate repair', () => {
  assert.deepEqual(routeWebhookEvent({ event: 'pull_request', payload: payload() }), [{
    type: 'gate',
    installationId: 77,
    owner: 'ORESoftware',
    repo: 'ores-gh-bots',
    prNumber: 55,
    headSha: 'a'.repeat(40),
    reason: 'pull_request.review_requested',
    force: true,
  }]);
});

test('review request routing does not turn unrelated pull-request actions into gate jobs', () => {
  const jobs = routeWebhookEvent({ event: 'pull_request', payload: payload('opened') });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'review');
  assert.equal(jobs[0].force, false);
});

test('malformed review-request payloads fail closed without partial jobs', () => {
  const variants = [payload(), payload(), payload(), payload()];
  delete variants[0].installation;
  delete variants[1].pull_request.head;
  delete variants[2].repository.owner;
  delete variants[3].pull_request.number;
  for (const malformed of variants) {
    assert.deepEqual(routeWebhookEvent({ event: 'pull_request', payload: malformed }), []);
  }
});
