const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const ADMISSION_CONCLUSIONS = new Set(['action_required', 'startup_failure']);
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'stale']);

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeSteps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('workflow job steps must be an array');
  return value;
}

function stepExecuted(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
  if (step.started_at || step.completed_at) return true;
  const status = normalizeText(step.status);
  const conclusion = normalizeText(step.conclusion);
  return status === 'in_progress'
    || (status === 'completed' && conclusion !== 'skipped' && conclusion !== null);
}

function runnerWasAssigned(job) {
  if (Number(job.runner_id ?? 0) > 0) return true;
  return typeof job.runner_name === 'string' && job.runner_name.trim().length > 0;
}

function frozenResult(result) {
  return Object.freeze({
    ...result,
    evidence: Object.freeze({ ...result.evidence }),
  });
}

export function classifyWorkflowJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    throw new TypeError('workflow job must be an object');
  }

  const status = normalizeText(job.status) ?? 'unknown';
  const conclusion = normalizeText(job.conclusion);
  const steps = normalizeSteps(job.steps);
  const executedStepCount = steps.filter(stepExecuted).length;
  const runnerAssigned = runnerWasAssigned(job);
  const evidence = {
    status,
    conclusion,
    step_count: steps.length,
    executed_step_count: executedStepCount,
    runner_assigned: runnerAssigned,
  };

  if (status !== 'completed') {
    return frozenResult({
      kind: 'pending',
      state: 'pending',
      product_failure: false,
      retryable_without_code_change: false,
      reason: `workflow job status=${status}`,
      evidence,
    });
  }

  if (SUCCESS_CONCLUSIONS.has(conclusion)) {
    return frozenResult({
      kind: 'success',
      state: 'success',
      product_failure: false,
      retryable_without_code_change: false,
      reason: `workflow job conclusion=${conclusion}`,
      evidence,
    });
  }

  if (conclusion === 'cancelled' && executedStepCount === 0) {
    return frozenResult({
      kind: 'cancelled_before_execution',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: true,
      reason: 'workflow job was cancelled before any step executed',
      evidence,
    });
  }

  if (executedStepCount > 0) {
    return frozenResult({
      kind: 'executed_failure',
      state: 'failure',
      product_failure: true,
      retryable_without_code_change: false,
      reason: `workflow job failed after ${executedStepCount} step(s) executed`,
      evidence,
    });
  }

  if (!runnerAssigned && (ADMISSION_CONCLUSIONS.has(conclusion) || FAILURE_CONCLUSIONS.has(conclusion))) {
    return frozenResult({
      kind: 'admission_failure',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: true,
      reason: `workflow job conclusion=${conclusion}; no runner or executed step was observed`,
      evidence,
    });
  }

  if (runnerAssigned && (ADMISSION_CONCLUSIONS.has(conclusion) || FAILURE_CONCLUSIONS.has(conclusion))) {
    return frozenResult({
      kind: 'runner_infrastructure_failure',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: true,
      reason: `workflow job conclusion=${conclusion}; a runner was assigned but no step executed`,
      evidence,
    });
  }

  return frozenResult({
    kind: 'unknown_failure',
    state: 'failure',
    product_failure: false,
    retryable_without_code_change: false,
    reason: `workflow job ended without executable evidence (conclusion=${conclusion ?? 'none'})`,
    evidence,
  });
}

const OUTCOME_PRIORITY = Object.freeze([
  'executed_failure',
  'unknown_failure',
  'runner_infrastructure_failure',
  'admission_failure',
  'cancelled_before_execution',
  'pending',
  'success',
]);

function runOnlyClassification(run) {
  const status = normalizeText(run?.status) ?? 'unknown';
  const conclusion = normalizeText(run?.conclusion);
  if (status !== 'completed') return 'pending';
  if (ADMISSION_CONCLUSIONS.has(conclusion)) return 'admission_failure';
  if (conclusion === 'cancelled') return 'cancelled_before_execution';
  if (SUCCESS_CONCLUSIONS.has(conclusion)) return 'unknown_failure';
  if (FAILURE_CONCLUSIONS.has(conclusion)) return 'unknown_failure';
  return 'unknown_failure';
}

export function classifyWorkflowEvidence(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('workflow evidence must be an object');
  }
  const jobs = input.jobs ?? [];
  if (!Array.isArray(jobs)) throw new TypeError('workflow evidence jobs must be an array');
  const classifications = jobs.map(classifyWorkflowJob);
  const counts = Object.fromEntries(OUTCOME_PRIORITY.map((kind) => [kind, 0]));
  for (const classification of classifications) counts[classification.kind] += 1;

  const outcome = classifications.length === 0
    ? runOnlyClassification(input.workflow_run ?? input.run ?? input)
    : OUTCOME_PRIORITY.find((kind) => counts[kind] > 0) ?? 'unknown_failure';
  const productFailure = counts.executed_failure > 0;
  const retryableWithoutCodeChange = !productFailure
    && counts.unknown_failure === 0
    && ['admission_failure', 'runner_infrastructure_failure', 'cancelled_before_execution']
      .some((kind) => counts[kind] > 0 || (classifications.length === 0 && outcome === kind));

  return Object.freeze({
    outcome,
    merge_blocking: outcome !== 'success',
    product_failure: productFailure,
    retryable_without_code_change: retryableWithoutCodeChange,
    job_count: classifications.length,
    counts: Object.freeze(counts),
    jobs: Object.freeze(classifications),
  });
}
