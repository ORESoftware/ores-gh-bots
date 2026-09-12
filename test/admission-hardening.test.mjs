import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowEvidence, classifyWorkflowJob } from '../packages/core/src/admission.mjs';

const step = (overrides = {}) => ({ status: 'completed', conclusion: 'success', ...overrides });
const job = (overrides = {}) => ({
  status: 'completed', conclusion: 'success', runner_id: 42,
  steps: [step()], ...overrides,
});
const run = (overrides = {}) => ({ status: 'completed', conclusion: 'success', ...overrides });

for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'unrecognized', null]) {
  test(`parent run ${conclusion} cannot be hidden by successful jobs`, () => {
    const result = classifyWorkflowEvidence({ workflow_run: run({ conclusion }), jobs: [job()] });
    assert.equal(result.merge_blocking, true);
    assert.notEqual(result.outcome, 'success');
    assert.equal(result.retryable_without_code_change, false);
  });
}

for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending', 'unknown', null]) {
  test(`parent run status ${status} vetoes a successful job snapshot`, () => {
    const result = classifyWorkflowEvidence({ workflow_run: run({ status, conclusion: null }), jobs: [job()] });
    assert.equal(result.merge_blocking, true);
    assert.equal(result.retryable_without_code_change, false);
  });
}

test('the run alias and top-level run status are not ignored', () => {
  for (const input of [
    { run: run({ conclusion: 'failure' }), jobs: [job()] },
    { ...run({ status: 'in_progress', conclusion: null }), jobs: [job()] },
  ]) assert.equal(classifyWorkflowEvidence(input).merge_blocking, true);
});

test('explicit malformed parent evidence is rejected, not silently discarded', () => {
  for (const value of [null, false, 'success', [], 17]) {
    assert.throws(() => classifyWorkflowEvidence({ workflow_run: value, jobs: [job()] }), /workflow run must be an object/);
  }
});

test('timestamped skipped steps do not prove execution', () => {
  const result = classifyWorkflowJob(job({ steps: [step({
    conclusion: 'skipped', started_at: '2026-09-08T00:00:00Z', completed_at: '2026-09-08T00:00:00Z',
  })] }));
  assert.equal(result.evidence.executed_step_count, 0);
  assert.equal(result.kind, 'unknown_failure');
});

test('non-string and invalid timestamps do not prove execution', () => {
  for (const started_at of [true, {}, 42, 'not-a-timestamp']) {
    const result = classifyWorkflowJob(job({ steps: [{ status: 'queued', conclusion: null, started_at }] }));
    assert.equal(result.evidence.executed_step_count, 0);
    assert.equal(result.kind, 'unknown_failure');
  }
});

test('successful parent and job cannot hide failed, pending, or unknown child steps', () => {
  for (const child of [step({ conclusion: 'failure' }), step({ conclusion: 'unrecognized' }), step({ status: 'in_progress', conclusion: null })]) {
    const result = classifyWorkflowEvidence({ workflow_run: run(), jobs: [job({ steps: [step(), child] })] });
    assert.equal(result.merge_blocking, true);
    assert.equal(result.retryable_without_code_change, false);
  }
});

test('a skipped or neutral-only workflow never certifies actual execution', () => {
  for (const conclusion of ['neutral', 'skipped']) {
    const result = classifyWorkflowEvidence({ workflow_run: run(), jobs: [job({ conclusion, steps: [] })] });
    assert.equal(result.merge_blocking, true);
  }
});

test('valid execution plus optional skipped jobs remains successful', () => {
  const result = classifyWorkflowEvidence({ workflow_run: run(), jobs: [job(), job({ conclusion: 'skipped', steps: [] })] });
  assert.equal(result.outcome, 'success');
  assert.equal(result.merge_blocking, false);
});

test('zero-step generic failures have unknown cause regardless of runner assignment', () => {
  for (const runner_id of [0, 42]) {
    const result = classifyWorkflowJob(job({ conclusion: 'failure', runner_id, steps: [] }));
    assert.equal(result.kind, 'unknown_failure');
    assert.equal(result.product_failure, false);
    assert.equal(result.retryable_without_code_change, false);
  }
});

test('cancellation and manual action never suggest retry, even mixed with startup failure', () => {
  for (const conclusion of ['cancelled', 'action_required']) {
    const blocked = job({ conclusion, runner_id: 0, steps: [] });
    assert.equal(classifyWorkflowJob(blocked).retryable_without_code_change, false);
    for (const jobs of [[], [blocked], [blocked, job({ conclusion: 'startup_failure', steps: [] })]]) {
      const result = classifyWorkflowEvidence({ workflow_run: run({ conclusion }), jobs });
      assert.equal(result.merge_blocking, true);
      assert.equal(result.retryable_without_code_change, false);
    }
  }
});

test('unknown status and conclusion text never escapes in classification receipts', () => {
  const secret = 'untrusted-diagnostic-payload-do-not-echo';
  for (const overrides of [{ status: secret }, { conclusion: secret }]) {
    const result = classifyWorkflowEvidence({ jobs: [job(overrides)] });
    assert.doesNotMatch(JSON.stringify(result), /untrusted-diagnostic-payload/);
    assert.equal(result.merge_blocking, true);
  }
});

test('malformed and sparse steps are rejected without echoing the input', () => {
  for (const steps of [[null], ['private-value'], [false], new Array(1)]) {
    assert.throws(() => classifyWorkflowJob(job({ steps })), /workflow job step must be an object/);
  }
});

test('runner admission does not invoke user-provided coercion hooks', () => {
  let invoked = false;
  const result = classifyWorkflowJob(job({ conclusion: 'failure', steps: [], runner_id: {
    valueOf() { invoked = true; throw new Error('private-value'); },
  } }));
  assert.equal(invoked, false);
  assert.equal(result.evidence.runner_assigned, false);
});

test('bounded state matrix: a supplied non-successful parent always blocks merge', () => {
  const statuses = ['completed', 'in_progress', 'queued', 'waiting', null];
  const conclusions = ['success', 'failure', 'timed_out', 'cancelled', 'action_required', null];
  let cases = 0;
  for (const status of statuses) for (const conclusion of conclusions) {
    if (status === 'completed' && conclusion === 'success') continue;
    for (const childStatus of statuses) for (const childConclusion of conclusions) {
      const result = classifyWorkflowEvidence({
        workflow_run: run({ status, conclusion }),
        jobs: [job({ status: childStatus, conclusion: childConclusion })],
      });
      assert.equal(result.merge_blocking, true, JSON.stringify({ status, conclusion, childStatus, childConclusion }));
      cases += 1;
    }
  }
  assert.equal(cases, 870);
});
