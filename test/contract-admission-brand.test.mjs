import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocallyVerifiedContractProjectionAdmission,
  verifyContractProjectionAdmission,
} from '../packages/core/src/contract-admission.mjs';

test('module-local admission brand does not survive structured cloning', () => {
  const result = verifyContractProjectionAdmission({
    manifest: {},
    reportText: '{}',
    contractIrText: '{}',
    expectedRepository: 'example/widget-api',
    expectedHeadSha: 'e'.repeat(40),
    allowedProducerCommits: ['f'.repeat(40)],
  });

  assert.equal(result.status, 'failed');
  assert.equal(isLocallyVerifiedContractProjectionAdmission(result), true);
  assert.equal(isLocallyVerifiedContractProjectionAdmission(structuredClone(result)), false);
});
