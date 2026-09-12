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

export async function fetchWorkflowRunEvidence(client, token, repository, runId, { signal } = {}) {
  const base = workflowRunBase(repository, runId);
  const [{ data: workflowRun }, jobs] = await Promise.all([
    client.request('GET', base, { token, signal }),
    client.paginate(`${base}/jobs?filter=latest&per_page=100`, {
      token,
      signal,
      map: (data) => data?.jobs,
    }),
  ]);
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
