import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkflowEvidence,
  classifyWorkflowJob,
} from '../packages/core/src/admission.mjs';

const completedJob = (overrides = {}) => ({
  id: 1,
  status: 'completed',
  conclusion: 'success',
  runner_id: 42,
  runner_name: 'hosted runner',
  steps: [{ status: 'completed', conclusion: 'success' }],
  ...overrides,
});

test('classifies an action-required zero-step job as an admission failure', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'action_required',
    runner_id: 0,
    runner_name: '',
    steps: [],
  }));
  assert.equal(result.kind, 'admission_failure');
  assert.equal(result.product_failure, false);
  assert.equal(result.retryable_without_code_change, true);
});

test('classifies a zero-step generic failure with no runner as an admission failure', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'failure',
    runner_id: null,
    runner_name: null,
    steps: [],
  }));
  assert.equal(result.kind, 'admission_failure');
});

test('classifies a runner-assigned zero-step failure as infrastructure failure', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'startup_failure',
    steps: [],
  }));
  assert.equal(result.kind, 'runner_infrastructure_failure');
  assert.equal(result.product_failure, false);
});

test('classifies a failed job with an executed step as a product failure', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'failure',
    steps: [{ status: 'completed', conclusion: 'failure' }],
  }));
  assert.equal(result.kind, 'executed_failure');
  assert.equal(result.product_failure, true);
  assert.equal(result.retryable_without_code_change, false);
});

test('started timestamps count as execution evidence', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'timed_out',
    steps: [{ status: 'queued', conclusion: null, started_at: '2026-09-06T10:00:00Z' }],
  }));
  assert.equal(result.kind, 'executed_failure');
  assert.equal(result.evidence.executed_step_count, 1);
});

test('does not count an explicitly skipped step as execution', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'failure',
    steps: [{ status: 'completed', conclusion: 'skipped' }],
  }));
  assert.equal(result.kind, 'runner_infrastructure_failure');
});

test('keeps a queued job pending', () => {
  const result = classifyWorkflowJob(completedJob({
    status: 'queued',
    conclusion: null,
    runner_id: 0,
    runner_name: '',
    steps: [],
  }));
  assert.equal(result.kind, 'pending');
  assert.equal(result.state, 'pending');
});

test('treats success, neutral, and skipped conclusions as successful job evidence', () => {
  for (const conclusion of ['success', 'neutral', 'skipped']) {
    assert.equal(classifyWorkflowJob(completedJob({ conclusion })).kind, 'success');
  }
});

test('a zero-step success job fails closed instead of becoming merge evidence', () => {
  const result = classifyWorkflowJob(completedJob({ steps: [] }));
  assert.equal(result.kind, 'unknown_failure');
  assert.equal(result.state, 'failure');
  assert.equal(result.retryable_without_code_change, false);
});

test('distinguishes cancellation before execution from product failure', () => {
  const result = classifyWorkflowJob(completedJob({
    conclusion: 'cancelled',
    runner_id: 0,
    runner_name: '',
    steps: [],
  }));
  assert.equal(result.kind, 'cancelled_before_execution');
  assert.equal(result.product_failure, false);
});

test('run-only action-required evidence remains merge-blocking and retryable', () => {
  const summary = classifyWorkflowEvidence({
    workflow_run: { status: 'completed', conclusion: 'action_required' },
    jobs: [],
  });
  assert.equal(summary.outcome, 'admission_failure');
  assert.equal(summary.merge_blocking, true);
  assert.equal(summary.retryable_without_code_change, true);
});

test('a successful run without job evidence fails closed', () => {
  const summary = classifyWorkflowEvidence({
    workflow_run: { status: 'completed', conclusion: 'success' },
    jobs: [],
  });
  assert.equal(summary.outcome, 'unknown_failure');
  assert.equal(summary.merge_blocking, true);
});

test('executed failures take precedence over admission failures', () => {
  const summary = classifyWorkflowEvidence({
    jobs: [
      completedJob({ conclusion: 'action_required', runner_id: 0, runner_name: '', steps: [] }),
      completedJob({ id: 2, conclusion: 'failure', steps: [{ status: 'completed', conclusion: 'failure' }] }),
    ],
  });
  assert.equal(summary.outcome, 'executed_failure');
  assert.equal(summary.product_failure, true);
  assert.equal(summary.counts.admission_failure, 1);
  assert.equal(summary.counts.executed_failure, 1);
});

test('all-success job evidence is the only merge-nonblocking result', () => {
  const summary = classifyWorkflowEvidence({
    jobs: [completedJob(), completedJob({ id: 2, conclusion: 'skipped' })],
  });
  assert.equal(summary.outcome, 'success');
  assert.equal(summary.merge_blocking, false);
});

test('rejects malformed evidence instead of guessing', () => {
  assert.throws(() => classifyWorkflowJob(null), /must be an object/);
  assert.throws(() => classifyWorkflowJob({ status: 'completed', steps: {} }), /steps must be an array/);
  assert.throws(() => classifyWorkflowEvidence({ jobs: {} }), /jobs must be an array/);
});
