import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWorkflowRun,
  dispatchWorkflow,
  fetchWorkflowRunEvidence,
} from '../packages/github/src/actions.mjs';

function mockClient({ workflowRun = { id: 77 }, jobs = [] } = {}) {
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

test('fetchWorkflowRunEvidence reads the run and all latest-attempt jobs', async () => {
  const jobs = [{ id: 1 }, { id: 2 }];
  const client = mockClient({ workflowRun: { id: 77, conclusion: 'failure' }, jobs });
  const controller = new AbortController();
  const evidence = await fetchWorkflowRunEvidence(client, 'token', 'owner/repo', '77', {
    signal: controller.signal,
  });

  assert.deepEqual(evidence.workflow_run, { id: 77, conclusion: 'failure' });
  assert.deepEqual(evidence.jobs, jobs);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.jobs), true);
  assert.deepEqual(client.calls.map(({ type, method, path }) => ({ type, method, path })), [
    { type: 'request', method: 'GET', path: '/repos/owner/repo/actions/runs/77' },
    { type: 'paginate', method: undefined, path: '/repos/owner/repo/actions/runs/77/jobs?filter=latest&per_page=100' },
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
    workflowRun: { id: 91, status: 'completed', conclusion: 'failure' },
    jobs: [{
      id: 1,
      status: 'completed',
      conclusion: 'action_required',
      runner_id: 0,
      runner_name: '',
      steps: [],
    }],
  });
  const result = await classifyWorkflowRun(client, 'token', 'owner/repo', 91);
  assert.equal(result.outcome, 'admission_failure');
  assert.equal(result.product_failure, false);
  assert.equal(result.retryable_without_code_change, true);
});

test('job pagination starts from a path without a query string', async () => {
  const client = mockClient();
  await fetchWorkflowRunEvidence(client, 'token', 'owner/repo', 77);
  assert.equal(client.calls[1].path, '/repos/owner/repo/actions/runs/77/jobs?filter=latest&per_page=100');
});
