const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const RUN_SUCCESS_CONCLUSIONS = new Set(['success']);
const ADMISSION_CONCLUSIONS = new Set(['action_required', 'startup_failure']);
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'stale']);
const STATUSES = new Set(['completed', 'queued', 'in_progress', 'waiting', 'requested', 'pending']);
const CONCLUSIONS = new Set([...SUCCESS_CONCLUSIONS, ...ADMISSION_CONCLUSIONS, ...FAILURE_CONCLUSIONS, 'cancelled']);

// Receipts contain closed classifications, never arbitrary provider/user text.
function normalizeText(value, allowed) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const text = value.trim().toLowerCase();
  return allowed.has(text) ? text : null;
}

function observedTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function normalizeSteps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('workflow job steps must be an array');
  for (const step of value) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new TypeError('workflow job step must be an object');
    }
  }
  return value;
}

function stepExecuted(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
  const status = normalizeText(step.status, STATUSES);
  const conclusion = normalizeText(step.conclusion, CONCLUSIONS);
  // Skipped steps can carry bookkeeping timestamps without executing commands.
  if (conclusion === 'skipped') return false;
  if (observedTimestamp(step.started_at) || observedTimestamp(step.completed_at)) return true;
  return status === 'in_progress'
    || (status === 'completed' && conclusion !== 'skipped' && conclusion !== null);
}

function runnerWasAssigned(job) {
  if (Number.isSafeInteger(job.runner_id) && job.runner_id > 0) return true;
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

  const status = normalizeText(job.status, STATUSES) ?? 'unknown';
  const conclusion = normalizeText(job.conclusion, CONCLUSIONS);
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

  const consistentSteps = steps.every((step) => normalizeText(step.status, STATUSES) === 'completed'
    && SUCCESS_CONCLUSIONS.has(normalizeText(step.conclusion, CONCLUSIONS)));
  if (SUCCESS_CONCLUSIONS.has(conclusion)
      && (!consistentSteps || (conclusion !== 'skipped' && executedStepCount === 0))) {
    return frozenResult({
      kind: 'unknown_failure',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: false,
      reason: 'workflow job reported success without consistent executed-step evidence',
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
      retryable_without_code_change: false,
      reason: 'workflow job was cancelled before any step executed',
      evidence,
    });
  }

  if (executedStepCount > 0 && FAILURE_CONCLUSIONS.has(conclusion)) {
    return frozenResult({
      kind: 'executed_failure',
      state: 'failure',
      product_failure: true,
      retryable_without_code_change: false,
      reason: `workflow job failed after ${executedStepCount} step(s) executed`,
      evidence,
    });
  }

  if (executedStepCount === 0 && !runnerAssigned && ADMISSION_CONCLUSIONS.has(conclusion)) {
    return frozenResult({
      kind: 'admission_failure',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: conclusion === 'startup_failure',
      reason: `workflow job conclusion=${conclusion}; no runner or executed step was observed`,
      evidence,
    });
  }

  if (executedStepCount === 0 && runnerAssigned && ADMISSION_CONCLUSIONS.has(conclusion)) {
    return frozenResult({
      kind: 'runner_infrastructure_failure',
      state: 'failure',
      product_failure: false,
      retryable_without_code_change: conclusion === 'startup_failure',
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
  const status = normalizeText(run?.status, STATUSES) ?? 'unknown';
  const conclusion = normalizeText(run?.conclusion, CONCLUSIONS);
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

  // An explicit run is a veto, even when the job list is stale or incomplete.
  // Validate every supported wrapper instead of letting null hide a failed run.
  const runs = [];
  for (const key of ['workflow_run', 'run']) {
    if (!Object.hasOwn(input, key)) continue;
    const run = input[key];
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      throw new TypeError('workflow run must be an object');
    }
    runs.push(run);
  }
  if (Object.hasOwn(input, 'status') || Object.hasOwn(input, 'conclusion')) runs.push(input);

  let outcome = classifications.length === 0
    ? runOnlyClassification(runs[0] ?? input)
    : OUTCOME_PRIORITY.find((kind) => counts[kind] > 0) ?? 'unknown_failure';
  // Optional neutral/skipped jobs may coexist with observed successful work, but
  // only an explicit parent run conclusion of success may certify the run.
  const runVetoes = runs.filter((run) => normalizeText(run.status, STATUSES) !== 'completed'
    || !RUN_SUCCESS_CONCLUSIONS.has(normalizeText(run.conclusion, CONCLUSIONS)));
  if (outcome === 'success' && runVetoes.length > 0) {
    const vetoes = runVetoes.map(runOnlyClassification);
    outcome = OUTCOME_PRIORITY.find((kind) => vetoes.includes(kind)) ?? 'unknown_failure';
  }
  if (outcome === 'success' && !classifications.some((job) => job.evidence.executed_step_count > 0)) {
    outcome = 'unknown_failure';
  }
  const productFailure = counts.executed_failure > 0;
  // A retry hint is not fallback authorization. Never override cancellation,
  // manual approval, unknown evidence, or still-running work with another job.
  const retryableRuns = runs.every((run) => normalizeText(run.status, STATUSES) === 'completed'
    && ['failure', 'startup_failure'].includes(normalizeText(run.conclusion, CONCLUSIONS)));
  const retryableWithoutCodeChange = classifications.length === 0
    ? runs.length > 0 && runs.every((run) => normalizeText(run.status, STATUSES) === 'completed'
      && normalizeText(run.conclusion, CONCLUSIONS) === 'startup_failure')
    : retryableRuns && classifications.some((job) => job.retryable_without_code_change)
      && classifications.every((job) => job.kind === 'success' || job.retryable_without_code_change);

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
