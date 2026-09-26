import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkflowRun,
  dispatchWorkflow,
  fetchWorkflowRunEvidence,
} from '../packages/github/src/actions.mjs';

const SHA = 'a'.repeat(40);
const run = (extra = {}) => ({ id: 77, run_attempt: 2, head_sha: SHA, repository: { full_name: 'owner/repo' }, ...extra });
const boundJob = (extra = {}) => ({ id: 1, run_id: 77, run_attempt: 2, head_sha: SHA, ...extra });

function mockClient({ workflowRun = run(), jobs = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, options) {
      calls.push({ type: 'request', method, path, options });
      return { data: workflowRun };
    },
    async paginate(path, options) {
      calls.push({ type: 'paginate', path, options });
      assert.deepEqual(options.map({ jobs }), jobs);
      return jobs;
    },
  };
}

test('dispatchWorkflow validates repository shape and stringifies inputs', async () => {
  const client = mockClient();
  await dispatchWorkflow(client, 'token', 'owner/repo', 'review.yml', 'main', { pr: 42, force: true });
  assert.deepEqual(client.calls[0], {
    type: 'request',
    method: 'POST',
    path: '/repos/owner/repo/actions/workflows/review.yml/dispatches',
    options: {
      token: 'token',
      body: { ref: 'main', inputs: { pr: '42', force: 'true' } },
    },
  });
  await assert.rejects(
    () => dispatchWorkflow(client, 'token', 'owner/repo/extra', 'review.yml', 'main', {}),
    /Invalid GitHub Actions repository/,
  );
});

test('fetchWorkflowRunEvidence pins jobs to the observed attempt', async () => {
  const jobs = [boundJob(), boundJob({ id: 2 })];
  const client = mockClient({ workflowRun: run({ conclusion: 'failure' }), jobs });
  const controller = new AbortController();
  const evidence = await fetchWorkflowRunEvidence(client, 'token', 'owner/repo', '77', {
    signal: controller.signal,
  });

  assert.deepEqual(evidence.workflow_run, run({ conclusion: 'failure' }));
  assert.deepEqual(evidence.jobs, jobs);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.jobs), true);
  assert.deepEqual(client.calls.map(({ type, method, path }) => ({ type, method, path })), [
    { type: 'request', method: 'GET', path: '/repos/owner/repo/actions/runs/77' },
    { type: 'paginate', method: undefined, path: '/repos/owner/repo/actions/runs/77/attempts/2/jobs?per_page=100' },
  ]);
  assert.equal(client.calls[0].options.signal, controller.signal);
  assert.equal(client.calls[1].options.signal, controller.signal);
});

test('fetchWorkflowRunEvidence rejects unsafe run identifiers before network calls', async () => {
  const client = mockClient();
  for (const runId of [0, -1, 1.5, 'abc', '1/../../secrets', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => fetchWorkflowRunEvidence(client, 'token', 'owner/repo', runId),
      /Invalid GitHub Actions run id/,
    );
  }
  assert.deepEqual(client.calls, []);
});

test('classifyWorkflowRun composes remote evidence with the core classifier', async () => {
  const client = mockClient({
    workflowRun: run({ id: 91, status: 'completed', conclusion: 'failure' }),
    jobs: [boundJob({
      id: 1,
      run_id: 91,
      status: 'completed',
      conclusion: 'action_required',
      runner_id: 0,
      runner_name: '',
      steps: [],
    })],
  });
  const result = await classifyWorkflowRun(client, 'token', 'owner/repo', 91);
  assert.equal(result.outcome, 'admission_failure');
  assert.equal(result.product_failure, false);
  assert.equal(result.retryable_without_code_change, false);
});

test('job pagination requires complete evidence', async () => {
  const client = mockClient();
  await fetchWorkflowRunEvidence(client, 'token', 'owner/repo', 77);
  assert.equal(client.calls[1].options.requireComplete, true);
  assert.equal(client.calls[1].path, '/repos/owner/repo/actions/runs/77/attempts/2/jobs?per_page=100');
});

test('candidate head mismatch is rejected before fetching jobs', async () => {
  const client = mockClient();
  await assert.rejects(() => fetchWorkflowRunEvidence(client, 'token', 'owner/repo', 77,
    { expectedHeadSha: 'b'.repeat(40) }), /expected candidate head/);
  assert.equal(client.calls.length, 1);
});

test('malformed expected candidate is rejected before network access', async () => {
  for (const expectedHeadSha of ['main', '', null, {}, 'a'.repeat(39)]) {
    const client = mockClient();
    await assert.rejects(() => fetchWorkflowRunEvidence(client, 'token', 'owner/repo', 77,
      { expectedHeadSha }), /Expected head SHA/);
    assert.equal(client.calls.length, 0);
  }
});

test('run and job identity substitutions cannot certify a candidate', async () => {
  for (const override of [{ id: 78 }, { run_attempt: 0 }, { head_sha: 'main' },
    { repository: { full_name: 'another/repo' } }]) {
    await assert.rejects(() => fetchWorkflowRunEvidence(mockClient({ workflowRun: run(override) }),
      'token', 'owner/repo', 77), /run identity/);
  }
  for (const override of [{ run_id: 78 }, { run_attempt: 3 }, { head_sha: 'b'.repeat(40) }, { id: undefined }]) {
    await assert.rejects(() => fetchWorkflowRunEvidence(mockClient({ jobs: [boundJob(override)] }),
      'token', 'owner/repo', 77), /Workflow jobs/);
  }
  await assert.rejects(() => fetchWorkflowRunEvidence(mockClient({ jobs: [boundJob(), boundJob()] }),
    'token', 'owner/repo', 77), /Workflow jobs/);
});

test('exact head success remains usable without mutating the response', async () => {
  const workflowRun = run({ status: 'completed', conclusion: 'success' });
  const jobs = [boundJob({ status: 'completed', conclusion: 'success',
    steps: [{ status: 'completed', conclusion: 'success' }] })];
  const result = await classifyWorkflowRun(mockClient({ workflowRun, jobs }), 'token', 'owner/repo', 77,
    { expectedHeadSha: SHA });
  assert.equal(result.outcome, 'success');
});
