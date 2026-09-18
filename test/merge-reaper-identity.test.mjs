import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMergeCandidate, validateMergeReaperPolicy } from '../packages/engine/src/merge-reaper.mjs';

const SHA = 'a'.repeat(40);
const policy = validateMergeReaperPolicy({ minimumAgeHours: 1 });

function candidate(baseRepo, externalId) {
  return evaluateMergeCandidate({
    pullRequest: {
      number: 7,
      state: 'open',
      draft: false,
      auto_merge: null,
      created_at: '2026-09-17T00:00:00Z',
      mergeable: true,
      mergeable_state: 'clean',
      labels: [{ name: 'ores-automerge' }],
      head: { sha: SHA },
      base: { ref: 'main', repo: baseRepo },
    },
    policy,
    now: new Date('2026-09-18T00:00:00Z'),
    gateCheck: {
      name: 'ores-review/gate',
      status: 'completed',
      conclusion: 'success',
      head_sha: SHA,
      external_id: externalId,
      app: { id: 42 },
    },
    expectedGateAppId: 42,
    ciStates: [{ context: 'ci/verify', state: 'success' }],
    reviews: [],
    unresolvedReviewThreads: 0,
    dependencyStates: {},
  });
}

test('reaper binds gate provenance to canonical base.repo.full_name casing', () => {
  const result = candidate(
    { name: 'repo', full_name: 'Org/Repo', owner: { login: 'org' } },
    `gate:Org/Repo#7@${SHA}`,
  );
  assert.equal(result.eligible, true);
  assert.equal(result.key, 'org/repo#7');
});

test('reaper fails closed when base repository identities disagree beyond case', () => {
  const result = candidate(
    { name: 'other', full_name: 'Org/Repo', owner: { login: 'Org' } },
    `gate:Org/Repo#7@${SHA}`,
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reasons.includes('invalid-pull-request-identity'), true);
  assert.equal(result.reasons.includes('gate-external-id-mismatch'), true);
});
