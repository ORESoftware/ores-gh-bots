import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowJob } from '../packages/core/src/admission.mjs';

for (const conclusion of ['startup_failure', 'action_required']) {
  for (const runner_id of [0, 42]) {
    test(`${conclusion} with executed steps and runner ${runner_id} is contradictory, not retryable`, () => {
      const result = classifyWorkflowJob({
        status: 'completed', conclusion, runner_id,
        steps: [{ status: 'completed', conclusion: 'success' }],
      });
      assert.equal(result.kind, 'unknown_failure');
      assert.equal(result.product_failure, false);
      assert.equal(result.retryable_without_code_change, false);
      assert.equal(result.evidence.executed_step_count, 1);
    });
  }
}
