import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/readiness.ts';
import { MERGE_CONFIDENCE_THRESHOLD, MIN_OPEN_HOURS } from '../src/config.ts';
import { NOW, approval, greenCheck, hoursAgo, pull } from './helpers.ts';

const clean = { reviews: [approval()], checks: [greenCheck()], now: NOW, disturbedBy: [] as string[] };

describe('readiness gates', () => {
  test('a fully clean, well-soaked PR is mergeable', () => {
    const r = evaluate({ pr: pull(), ...clean });
    assert.equal(r.blockedBy.length, 0, `unexpected blockers: ${r.blockedBy.join(',')}`);
    assert.ok(r.confidence >= MERGE_CONFIDENCE_THRESHOLD);
    assert.equal(r.recommendation, 'merge');
  });

  test(`the ${MIN_OPEN_HOURS}h soak gate blocks an otherwise perfect PR`, () => {
    const r = evaluate({ pr: pull({ created_at: hoursAgo(MIN_OPEN_HOURS - 0.5) }), ...clean });
    assert.ok(r.blockedBy.includes(`open>=${MIN_OPEN_HOURS}h`));
    assert.equal(r.mergeable, false);
    assert.equal(r.confidence, 0, 'a failed gate must zero confidence, not merely lower it');
  });

  test('soak gate passes exactly at the boundary', () => {
    const r = evaluate({ pr: pull({ created_at: hoursAgo(MIN_OPEN_HOURS) }), ...clean });
    assert.ok(!r.blockedBy.includes(`open>=${MIN_OPEN_HOURS}h`));
  });

  test('no amount of signal strength can buy past a gate', () => {
    const r = evaluate({
      pr: pull({ created_at: hoursAgo(1) }),
      reviews: [approval('a'), approval('b'), approval('c')],
      checks: [greenCheck('ci'), greenCheck('lint'), greenCheck('e2e')],
      now: NOW,
      disturbedBy: [],
    });
    assert.equal(r.mergeable, false);
    assert.equal(r.recommendation, 'hold');
  });

  test('unknown mergeability is not treated as mergeable', () => {
    const r = evaluate({ pr: pull({ mergeable: null, mergeable_state: 'unknown' }), ...clean });
    assert.ok(r.blockedBy.includes('no-conflicts'));
  });

  test('a conflict escalates rather than holding', () => {
    const r = evaluate({ pr: pull({ mergeable: false, mergeable_state: 'dirty' }), ...clean });
    assert.equal(r.recommendation, 'escalate');
    assert.match(r.reason, /never a side-pick/);
  });

  test('changes-requested blocks even after a later approval by someone else', () => {
    const r = evaluate({
      pr: pull(),
      reviews: [
        { state: 'CHANGES_REQUESTED', user: { login: 'x' }, submitted_at: hoursAgo(5) },
        approval('y'),
      ],
      checks: [greenCheck()],
      now: NOW,
      disturbedBy: [],
    });
    assert.ok(r.blockedBy.includes('no-changes-requested'));
  });

  test('a reviewer who requested changes and then approved no longer blocks', () => {
    const r = evaluate({
      pr: pull(),
      reviews: [
        { state: 'CHANGES_REQUESTED', user: { login: 'x' }, submitted_at: hoursAgo(5) },
        approval('x'),
      ],
      checks: [greenCheck()],
      now: NOW,
      disturbedBy: [],
    });
    assert.ok(!r.blockedBy.includes('no-changes-requested'));
  });

  test('in-flight checks block, they do not merely lower confidence', () => {
    const r = evaluate({
      pr: pull(),
      reviews: [approval()],
      checks: [greenCheck(), { name: 'slow', status: 'in_progress', conclusion: null }],
      now: NOW,
      disturbedBy: [],
    });
    assert.ok(r.blockedBy.includes('checks-complete'));
  });

  test('a failing check blocks', () => {
    const r = evaluate({
      pr: pull(),
      reviews: [approval()],
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
      now: NOW,
      disturbedBy: [],
    });
    assert.ok(r.blockedBy.includes('checks-not-failing'));
  });

  test('skipped and neutral checks do not count as failures', () => {
    const r = evaluate({
      pr: pull(),
      reviews: [approval()],
      checks: [greenCheck(), { name: 'opt', status: 'completed', conclusion: 'skipped' }],
      now: NOW,
      disturbedBy: [],
    });
    assert.ok(!r.blockedBy.includes('checks-not-failing'));
  });

  test('a missing required check blocks', () => {
    const r = evaluate({ pr: pull(), ...clean, requiredCheckNames: ['e2e'] });
    assert.ok(r.blockedBy.includes('required-checks-green'));
  });

  test('hold labels block', () => {
    for (const name of ['do-not-merge', 'WIP', 'blocked', 'hold']) {
      const r = evaluate({ pr: pull({ labels: [{ name }] }), ...clean });
      assert.ok(r.blockedBy.includes('no-hold-label'), `${name} should block`);
    }
  });

  test('draft PRs are never merged', () => {
    const r = evaluate({ pr: pull({ draft: true }), ...clean });
    assert.ok(r.blockedBy.includes('not-draft'));
  });

  test('dependency movement recommends update, not merge', () => {
    const r = evaluate({ pr: pull(), ...clean, disturbedBy: ['zed-pkg/zed-lib'] });
    assert.equal(r.recommendation, 'update');
    assert.match(r.reason, /zed-pkg\/zed-lib/);
  });

  test('a branch behind its base is updated', () => {
    const r = evaluate({ pr: pull({ mergeable_state: 'behind' }), ...clean });
    assert.equal(r.recommendation, 'update');
  });
});
