import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMergeCandidate,
  orderMergeCandidates,
  parsePullRequestDependencies,
  selectMergeBatch,
  topologicallyOrderRepositories,
  validateMergeReaperPolicy,
} from '../packages/engine/src/merge-reaper.mjs';

const now = new Date('2026-09-02T20:00:00.000Z');
const policy = validateMergeReaperPolicy({
  minimumAgeHours: 55,
  maxMerges: 3,
  maxRepositories: 100,
  maxPullRequestsPerRepository: 100,
  repositoryDependencies: {},
});

function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    auto_merge: null,
    created_at: '2026-08-30T00:00:00.000Z',
    mergeable: true,
    mergeable_state: 'clean',
    labels: [{ name: 'ores-automerge' }],
    head: { sha: 'a'.repeat(40) },
    base: {
      ref: 'main',
      repo: {
        name: 'repo',
        full_name: 'Org/Repo',
        owner: { login: 'Org' },
      },
    },
    ...overrides,
  };
}

function gate(overrides = {}) {
  return {
    name: 'ores-review/gate',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    external_id: `gate:Org/Repo#7@${'a'.repeat(40)}`,
    app: { id: 42 },
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateMergeCandidate({
    pullRequest: pullRequest(),
    policy,
    now,
    gateCheck: gate(),
    expectedGateAppId: 42,
    expectedGateExternalId: `gate:Org/Repo#7@${'a'.repeat(40)}`,
    ciStates: [{ context: 'ci/verify', state: 'success' }],
    reviews: [],
    unresolvedReviewThreads: 0,
    dependencyStates: {},
    ...overrides,
  });
}

test('eligible merge requires age, clean exact-head gate, independent CI, thread resolution, and opt-in', () => {
  const result = evaluate();
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.key, 'org/repo#7');
  assert.equal(result.ageHours, 92);
});

test('merge policy fails closed for every mutable safety boundary', () => {
  const result = evaluate({
    pullRequest: pullRequest({
      draft: true,
      mergeable: false,
      mergeable_state: 'dirty',
      labels: [{ name: 'blocked' }],
      created_at: '2026-09-02T19:00:00.000Z',
      auto_merge: {},
    }),
    gateCheck: gate({ app: { id: 99 }, external_id: 'foreign', conclusion: 'failure' }),
    ciStates: [{ context: 'ci/verify', state: 'pending' }],
    reviews: [{ id: 1, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-02T18:00:00Z', user: { login: 'reviewer', type: 'User' } }],
    unresolvedReviewThreads: 2,
    dependencyStates: { 'other/repo#3': 'open' },
  });
  assert.equal(result.eligible, false);
  for (const reason of [
    'draft-pull-request',
    'native-auto-merge-already-enabled',
    'younger-than-minimum-age',
    'not-mergeable',
    'mergeable-state-not-clean',
    'denied-label:blocked',
    'missing-automerge-opt-in-label',
    'gate-app-identity-mismatch',
    'gate-external-id-mismatch',
    'gate-not-success:failure',
    'ci-not-success:ci/verify:pending',
    'changes-requested',
    'unresolved-review-threads:2',
    'dependency-not-ready:other/repo#3:open',
  ]) assert.equal(result.reasons.includes(reason), true, reason);
});

test('dependency directives are explicit, normalized, local-aware, and deduplicated', () => {
  const dependencies = parsePullRequestDependencies(`
Depends-On: Other/Library#19, #3
Stacked-On: https://github.com/Org/Repo/pull/3
Requires: third/repo#5
`, { owner: 'Org', repo: 'Repo' });
  assert.deepEqual(dependencies, ['org/repo#3', 'other/library#19', 'third/repo#5']);
});

test('candidate ordering respects explicit and repository dependencies', () => {
  const ordered = orderMergeCandidates([
    { key: 'org/app#2', repository: 'org/app', createdAt: '2026-08-01T00:00:00Z', dependencies: ['org/lib#1'], eligible: true },
    { key: 'org/monorepo#4', repository: 'org/monorepo', createdAt: '2026-07-01T00:00:00Z', dependencies: [], eligible: true },
    { key: 'org/lib#1', repository: 'org/lib', createdAt: '2026-09-01T00:00:00Z', dependencies: [], eligible: true },
  ], { 'org/monorepo': ['org/app'] });
  assert.deepEqual(ordered.map((candidate) => candidate.key), ['org/lib#1', 'org/app#2', 'org/monorepo#4']);
});

test('dependency cycles and attempts to exceed three effects are rejected', () => {
  assert.throws(
    () => topologicallyOrderRepositories(['org/a', 'org/b'], { 'org/a': ['org/b'], 'org/b': ['org/a'] }),
    /dependency cycle/u,
  );
  assert.throws(
    () => orderMergeCandidates([
      { key: 'org/a#1', repository: 'org/a', dependencies: ['org/b#2'] },
      { key: 'org/b#2', repository: 'org/b', dependencies: ['org/a#1'] },
    ]),
    /dependency cycle/u,
  );
  assert.throws(() => validateMergeReaperPolicy({ maxMerges: 4 }), /between 1 and 3/u);
  assert.deepEqual(
    selectMergeBatch(Array.from({ length: 5 }, (_, index) => ({ eligible: true, index })), 3).map((item) => item.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    selectMergeBatch([
      { evaluation: { eligible: true }, key: 'a' },
      { evaluation: { eligible: false }, key: 'b' },
      { evaluation: { eligible: true }, key: 'c' },
    ], 3).map((item) => item.key),
    ['a', 'c'],
  );
});

test('policy validation rejects malformed and ambiguous configuration', () => {
  for (const [input, pattern] of [
    [null, /must be an object/u],
    [{ unknown: true }, /Unknown merge reaper policy fields/u],
    [{ version: 2 }, /version must be 1/u],
    [{ mergeMethod: 'force' }, /mergeMethod/u],
    [{ allowedBaseBranches: 'main' }, /must be an array/u],
    [{ optInLabels: ['x', 'X'] }, /duplicates/u],
    [{ requireOptInLabel: true, optInLabels: [] }, /must not be empty/u],
    [{ optInLabels: ['hold'], denyLabels: ['hold'] }, /both opt-in and denied/u],
    [{ repositoryDependencies: [] }, /must be an object/u],
    [{ repositoryDependencies: { bad: [] } }, /OWNER\/REPO/u],
    [{ repositoryDependencies: { 'org/a': ['org/a'] } }, /must not depend on itself/u],
  ]) assert.throws(() => validateMergeReaperPolicy(input), pattern);
});

test('dynamic policy surfaces fail closed when evidence is absent or malformed', () => {
  const humanPolicy = validateMergeReaperPolicy({
    ...policy,
    requireHumanApproval: true,
    ignoredCiContexts: ['ci/optional'],
  });
  const result = evaluateMergeCandidate({
    pullRequest: pullRequest({
      number: 0,
      state: 'closed',
      created_at: 'not-a-date',
      mergeable: null,
      mergeable_state: 'unknown',
      base: { ref: 'feature', repo: { full_name: 'invalid' } },
      labels: ['ores-automerge'],
    }),
    policy: humanPolicy,
    now: 'not-a-date',
    gateCheck: null,
    expectedGateAppId: 0,
    expectedGateExternalId: 'expected',
    ciStates: [{ context: 'ci/optional', state: 'failure' }],
    reviews: [
      { id: 1, state: 'PENDING', submitted_at: '', user: { login: 'ignored', type: 'User' } },
      { id: 2, state: 'APPROVED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'bot', type: 'Bot' } },
    ],
    unresolvedReviewThreads: null,
  });
  for (const reason of [
    'invalid-pull-request-identity',
    'pull-request-not-open',
    'invalid-created-at',
    'base-branch-not-allowed',
    'mergeability-unknown',
    'mergeable-state-not-clean',
    'invalid-expected-gate-app-id',
    'missing-ores-gate',
    'no-independent-ci-contexts',
    'missing-human-approval',
    'review-thread-state-unavailable',
  ]) assert.equal(result.reasons.includes(reason), true, reason);
});

test('latest human approval can satisfy an approval policy while stale requested changes do not', () => {
  const humanPolicy = validateMergeReaperPolicy({ ...policy, requireHumanApproval: true });
  const result = evaluate({
    policy: humanPolicy,
    reviews: [
      { id: 1, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-01T00:00:00Z', user: { login: 'human', type: 'User' } },
      { id: 2, state: 'APPROVED', submitted_at: '2026-09-02T00:00:00Z', user: { login: 'human', type: 'User' } },
      { id: 3, state: 'COMMENTED', submitted_at: '2026-09-02T00:00:00Z', user: { login: '', type: 'User' } },
    ],
    dependencyStates: { 'other/repo#1': 'merged', 'other/repo#2': 'eligible-earlier' },
  });
  assert.equal(result.eligible, true);
});

test('gate progress and missing CI evidence never count as green', () => {
  const pending = evaluate({
    gateCheck: gate({ status: 'in_progress', conclusion: null }),
    ciStates: [],
  });
  assert.equal(pending.reasons.includes('gate-not-success:in_progress'), true);
  assert.equal(pending.reasons.includes('no-independent-ci-contexts'), true);
});

test('repository ordering returns only requested nodes and still honors transitive dependencies', () => {
  assert.deepEqual(
    topologicallyOrderRepositories(['Org/App', 'org/monorepo'], {
      'org/monorepo': ['org/app'],
      'org/app': ['org/lib'],
    }),
    ['org/app', 'org/monorepo'],
  );
});

test('candidate ordering rejects duplicates and ignores dependencies outside the current candidate set', () => {
  assert.throws(
    () => orderMergeCandidates([
      { key: 'org/a#1', repository: 'org/a' },
      { key: 'org/a#1', repository: 'org/a' },
    ]),
    /unique keys/u,
  );
  assert.deepEqual(
    orderMergeCandidates([
      { key: 'org/a#1', repository: 'org/a', dependencies: ['org/missing#9'] },
      { key: 'org/b#2', repository: 'org/b', dependencies: ['org/b#2'] },
    ]).map((candidate) => candidate.key),
    ['org/a#1', 'org/b#2'],
  );
});
