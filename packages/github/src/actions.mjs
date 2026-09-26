import { classifyWorkflowEvidence } from '../../core/src/admission.mjs';

function parseRepository(repository) {
  const segments = String(repository ?? '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    throw new Error(`Invalid GitHub Actions repository: ${repository}`);
  }
  return segments;
}

function parseRunId(runId) {
  const value = typeof runId === 'string' && /^\d+$/.test(runId) ? Number(runId) : runId;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid GitHub Actions run id: ${runId}`);
  }
  return value;
}

function workflowRunBase(repository, runId) {
  const [owner, repo] = parseRepository(repository);
  const id = parseRunId(runId);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${id}`;
}

export async function dispatchWorkflow(client, token, repository, workflowId, ref, inputs) {
  const [owner, repo] = parseRepository(repository);
  await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    token,
    body: { ref, inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value)])) },
  });
}

export async function fetchWorkflowRunEvidence(client, token, repository, runId, { signal, expectedHeadSha } = {}) {
  const base = workflowRunBase(repository, runId);
  if (expectedHeadSha !== undefined && !/^[a-f0-9]{40}$/.test(expectedHeadSha)) {
    throw new TypeError('Expected head SHA must be a full lowercase Git commit');
  }
  const { data: workflowRun } = await client.request('GET', base, { token, signal });
  if (workflowRun?.id !== parseRunId(runId)
      || !Number.isSafeInteger(workflowRun.run_attempt) || workflowRun.run_attempt < 1
      || !/^[a-f0-9]{40}$/.test(workflowRun.head_sha ?? '')
      || workflowRun.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Workflow run identity is missing or inconsistent');
  }
  if (expectedHeadSha !== undefined && workflowRun.head_sha !== expectedHeadSha) {
    throw new Error('Workflow run does not match the expected candidate head');
  }
  // Pin jobs to the observed attempt: a concurrent rerun must not substitute
  // its jobs underneath the already-fetched parent conclusion.
  const jobs = await client.paginate(`${base}/attempts/${workflowRun.run_attempt}/jobs?per_page=100`, {
    token,
    signal,
    requireComplete: true,
    map: (data) => data?.jobs,
  });
  if (jobs.some((job) => job.run_id !== workflowRun.id
      || job.run_attempt !== workflowRun.run_attempt || job.head_sha !== workflowRun.head_sha)
      || new Set(jobs.map((job) => job.id)).size !== jobs.length
      || jobs.some((job) => !Number.isSafeInteger(job.id) || job.id < 1)) {
    throw new Error('Workflow jobs do not uniquely identify the observed run attempt and head');
  }
  return Object.freeze({
    workflow_run: workflowRun,
    jobs: Object.freeze([...jobs]),
  });
}

export async function classifyWorkflowRun(client, token, repository, runId, options) {
  return classifyWorkflowEvidence(
    await fetchWorkflowRunEvidence(client, token, repository, runId, options),
  );
}
