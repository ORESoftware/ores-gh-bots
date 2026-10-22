import test from 'node:test';
import assert from 'node:assert/strict';
import { findStackedBasePullRequest } from '../apps/reaper/src/stacked-base.mjs';

function pr(number, repo, ref) {
  return { number, head: { ref, repo: repo === null ? null : { full_name: repo } } };
}

test('stacked dependency chooses same-repository branch, not a matching fork branch', () => {
  const fork = pr(11, 'untrusted/other-fork', 'shared-feature');
  const legitimate = pr(12, 'Org/Repo', 'shared-feature');
  const found = findStackedBasePullRequest([fork, legitimate], 'org/repo', 'shared-feature', 13);
  assert.equal(found.number, 12);
});

test('fork branch name alone is never treated as a source repository dependency', () => {
  const open = [pr(11, 'forker/repo', 'my-branch'), pr(12, 'somebody/other', 'main')];
  assert.equal(findStackedBasePullRequest(open, 'Org/Repo', 'my-branch', 13), null);
  assert.equal(findStackedBasePullRequest(open, 'Org/Repo', 'main', 13), null);
});

test('a pull request never depends on itself; comparisons preserve repository casing neutrality', () => {
  assert.equal(findStackedBasePullRequest([pr(17, 'ORG/REPO', 'shared')], 'org/repo', 'shared', 17), null);
  assert.equal(findStackedBasePullRequest([pr(17, 'ORG/REPO', 'shared')], 'org/repo', 'shared', 18)?.number, 17);
});

test('missing head repository identity on matching branch fails closed', () => {
  assert.throws(
    () => findStackedBasePullRequest([pr(11, null, 'my-branch')], 'org/repo', 'my-branch', 12),
    /unknown head repository/u,
  );
  // A missing identity on a nonmatching branch does not affect the known dependency.
  assert.equal(
    findStackedBasePullRequest([pr(11, null, 'unrelated'), pr(12, 'org/repo', 'my-branch')],
      'org/repo', 'my-branch', 13)?.number,
    12,
  );
});

test('invalid dependency inventory and repository metadata never infer a stacked parent', () => {
  assert.throws(() => findStackedBasePullRequest({}, 'org/repo', 'branch', 12), /inventory must be an array/u);
  assert.throws(() => findStackedBasePullRequest([], 'bad', 'branch', 12), /owner\/repo/u);
  assert.equal(findStackedBasePullRequest([pr(11, 'org/repo', 'branch')], 'org/repo', '', 12), null);
});
