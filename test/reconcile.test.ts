import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePull, summarise, type PullOutcome } from '../src/reconcile.ts';
import { buildGraph } from '../src/depgraph.ts';
import type { GitHubClient } from '../src/github.ts';
import { MIN_OPEN_HOURS } from '../src/config.ts';
import { NOW, approval, greenCheck, hoursAgo, pull } from './helpers.ts';

/** Records every mutating call so tests can assert what did and did not happen. */
function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const client = {
    calls,
    getPull: async () => (over.pr as ReturnType<typeof pull>) ?? pull(),
    listReviews: async () => (over.reviews as unknown[]) ?? [approval()],
    listCheckRuns: async () => (over.checks as unknown[]) ?? [greenCheck()],
    listPullFiles: async () => [{ filename: 'src/a.ts' }],
    merge: async () => { calls.push('merge'); },
    updateBranch: async () => { calls.push('updateBranch'); return over.updateOk !== false; },
    comment: async () => { calls.push('comment'); },
    addLabels: async () => { calls.push('addLabels'); },
  };
  return client as unknown as GitHubClient & { calls: string[] };
}

const ctx = (dryRun: boolean) => ({
  graph: buildGraph([]),
  pushedAt: new Map<string, string>(),
  siblings: [] as Array<{ number: number; files: readonly string[] }>,
  now: NOW,
  dryRun,
});

describe('reconcilePull', () => {
  test('dry run never mutates, even for a mergeable PR', async () => {
    const gh = fakeClient();
    const out = await reconcilePull(gh, 'o', 'r', pull(), ctx(true));
    assert.equal(out.action, 'skipped');
    assert.match(out.reason, /would merge/);
    assert.deepEqual(gh.calls, [], 'dry run must issue no mutating calls');
  });

  test('apply mode merges a clean, soaked PR', async () => {
    const gh = fakeClient();
    const out = await reconcilePull(gh, 'o', 'r', pull(), ctx(false));
    assert.equal(out.action, 'merged');
    assert.deepEqual(gh.calls, ['merge']);
  });

  test('the soak gate is re-asserted at action time, not just at scoring time', async () => {
    // A PR that scores mergeable but is young must still not be merged. This
    // guards against a future scoring change quietly dropping the 55h rule.
    const young = pull({ created_at: hoursAgo(MIN_OPEN_HOURS - 1) });
    const gh = fakeClient({ pr: young });
    const out = await reconcilePull(gh, 'o', 'r', young, ctx(false));
    assert.notEqual(out.action, 'merged');
    assert.deepEqual(gh.calls, [], 'a young PR must not be merged');
  });

  test('a conflicted PR is labelled and given a dossier, never resolved', async () => {
    const conflicted = pull({ mergeable: false, mergeable_state: 'dirty' });
    const gh = fakeClient({ pr: conflicted });
    const out = await reconcilePull(gh, 'o', 'r', conflicted, ctx(false));
    assert.equal(out.action, 'escalated');
    assert.deepEqual(gh.calls, ['addLabels', 'comment']);
    assert.ok(!gh.calls.includes('merge'));
  });

  test('a conflicted draft is never labelled or commented', async () => {
    const conflictedDraft = pull({ draft: true, mergeable: false, mergeable_state: 'dirty' });
    const gh = fakeClient({ pr: conflictedDraft });
    const out = await reconcilePull(gh, 'o', 'r', conflictedDraft, ctx(false));
    assert.equal(out.action, 'held');
    assert.deepEqual(gh.calls, [], 'draft PRs must remain immutable to unattended automation');
  });

  test('an already-flagged conflict is not re-commented on every night', async () => {
    const conflicted = pull({
      mergeable: false,
      mergeable_state: 'dirty',
      labels: [{ name: 'needs-semantic-merge' }],
    });
    const gh = fakeClient({ pr: conflicted });
    const out = await reconcilePull(gh, 'o', 'r', conflicted, ctx(false));
    assert.equal(out.action, 'escalated');
    assert.deepEqual(gh.calls, [], 'no duplicate label or comment');
  });

  test('a branch behind its base is updated', async () => {
    const behind = pull({ mergeable_state: 'behind' });
    const gh = fakeClient({ pr: behind });
    const out = await reconcilePull(gh, 'o', 'r', behind, ctx(false));
    assert.equal(out.action, 'updated');
    assert.deepEqual(gh.calls, ['updateBranch']);
  });

  test('a hold-labelled behind branch is never updated', async () => {
    const heldBehind = pull({ labels: [{ name: 'hold' }], mergeable_state: 'behind' });
    const gh = fakeClient({ pr: heldBehind });
    const out = await reconcilePull(gh, 'o', 'r', heldBehind, ctx(false));
    assert.equal(out.action, 'held');
    assert.deepEqual(gh.calls, [], 'held PRs must remain immutable to unattended automation');
  });

  test('a refused update-branch becomes an escalation, not a silent success', async () => {
    const behind = pull({ mergeable_state: 'behind' });
    const gh = fakeClient({ pr: behind, updateOk: false });
    const out = await reconcilePull(gh, 'o', 'r', behind, ctx(false));
    assert.equal(out.action, 'escalated');
    assert.ok(gh.calls.includes('addLabels'));
  });

  test('dependency movement triggers an update rather than a merge', async () => {
    const graph = buildGraph([{ from: 'o/r', to: 'o/lib', kind: 'zed' as const, spec: null }]);
    const gh = fakeClient();
    const out = await reconcilePull(gh, 'o', 'r', pull(), {
      ...ctx(false),
      graph,
      pushedAt: new Map([['o/lib', hoursAgo(0.5)]]),
    });
    assert.equal(out.action, 'updated');
    assert.deepEqual(out.disturbedBy, ['o/lib']);
  });

  test('an API failure is recorded, not thrown, so one bad PR cannot abort the fleet pass', async () => {
    const gh = fakeClient();
    (gh as unknown as { merge: () => Promise<void> }).merge = async () => {
      throw new Error('boom');
    };
    const out = await reconcilePull(gh, 'o', 'r', pull(), ctx(false));
    assert.equal(out.action, 'failed');
    assert.match(out.reason, /boom/);
  });
});

describe('summarise', () => {
  test('counts every action class', () => {
    const outcomes = [
      { action: 'merged' }, { action: 'merged' }, { action: 'escalated' }, { action: 'held' },
    ] as PullOutcome[];
    const text = summarise({
      startedAt: '', finishedAt: '', dryRun: false,
      reposScanned: 3, pullsScanned: 4, outcomes, apiCalls: 12,
    });
    assert.match(text, /merged 2/);
    assert.match(text, /escalated 1/);
    assert.match(text, /repos 3 · pulls 4 · api 12/);
  });
});
