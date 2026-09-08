import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowEvidence } from '../packages/core/src/admission.mjs';

const successfulJob = {
  status: 'completed',
  conclusion: 'success',
  runner_id: 42,
  steps: [{ status: 'completed', conclusion: 'success' }],
};

for (const conclusion of ['neutral', 'skipped']) {
  for (const wrapper of ['workflow_run', 'run', 'top-level']) {
    test(`parent ${conclusion} conclusion via ${wrapper} cannot certify successful child work`, () => {
      const parent = { status: 'completed', conclusion };
      const input = wrapper === 'top-level'
        ? { ...parent, jobs: [successfulJob] }
        : { [wrapper]: parent, jobs: [successfulJob] };
      const result = classifyWorkflowEvidence(input);
      assert.equal(result.outcome, 'unknown_failure');
      assert.equal(result.merge_blocking, true);
      assert.equal(result.retryable_without_code_change, false);
    });
  }
}
