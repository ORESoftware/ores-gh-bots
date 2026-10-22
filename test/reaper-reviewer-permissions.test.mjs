import test from 'node:test';
import assert from 'node:assert/strict';
import { attestMergeReaperReviewerPermissions } from '../packages/github/src/merge-reaper.mjs';

function approval(login, state = 'APPROVED') {
  return { state, user: { login, type: 'User' } };
}

test('attestation reads exact source repository collaborator permission and binds each reviewer', async () => {
  const seen = [];
  const client = {
    async request(method, path) {
      seen.push([method, path]);
      assert.equal(method, 'GET');
      if (path.endsWith('/alice/permission')) return { data: { permission: 'write' } };
      if (path.endsWith('/bob/permission')) return { data: { permission: 'read' } };
      throw new Error('unplanned permission lookup');
    },
  };
  const raw = [approval('Alice'), approval('Bob'), approval('ALICE', 'COMMENTED'), approval('bot', 'PENDING')];
  const result = await attestMergeReaperReviewerPermissions(client, 'token', 'Org', 'Repo', raw);
  assert.deepEqual(result.map((x) => x.verified_reviewer_permission), ['write', 'read', 'write', null]);
  assert.deepEqual(seen, [
    ['GET', '/repos/Org/Repo/collaborators/alice/permission'],
    ['GET', '/repos/Org/Repo/collaborators/bob/permission'],
  ]);
  assert.equal(raw[0].verified_reviewer_permission, undefined);
});

test('missing collaborator is recorded as no permission while 403 and other API errors fail closed', async () => {
  const missingClient = {
    async request() { throw Object.assign(new Error('not a collaborator'), { status: 404 }); },
  };
  const [denied] = await attestMergeReaperReviewerPermissions(
    missingClient, 'token', 'owner', 'repo', [approval('outsider')],
  );
  assert.equal(denied.verified_reviewer_permission, 'none');
  for (const status of [403, 429, 500]) {
    const c = {
      async request() { throw Object.assign(new Error('permission evidence unavailable'), { status }); },
    };
    await assert.rejects(
      attestMergeReaperReviewerPermissions(c, 'token', 'owner', 'repo', [approval('reviewer')]),
      /permission evidence unavailable/u,
    );
  }
});

test('reviewer permission attestation is bounded, fail-closed and does not look up bots', async () => {
  const c = {
    async request() { throw new Error('unexpected GitHub call'); },
  };
  const bogus = Array.from({ length: 33 }, (_, index) => approval('reviewer-' + index));
  await assert.rejects(
    attestMergeReaperReviewerPermissions(c, 'token', 'owner', 'repo', bogus),
    /too many distinct approving reviewers/u,
  );
  const [bot, commented] = await attestMergeReaperReviewerPermissions(c, 'token', 'owner', 'repo', [
    { state: 'APPROVED', user: { login: 'bot', type: 'Bot' } },
    approval('comment-only', 'COMMENTED'),
  ]);
  assert.equal(bot.verified_reviewer_permission, null);
  assert.equal(commented.verified_reviewer_permission, null);
  await assert.rejects(attestMergeReaperReviewerPermissions(c, 'token', 'owner', 'repo', null), /review array/u);
});
