import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLocallyVerifiedContractProjectionAdmission,
  verifyContractProjectionAdmission,
} from '../packages/core/src/contract-admission.mjs';

function failedAdmission() {
  return verifyContractProjectionAdmission({
    manifest: {},
    reportText: '{}',
    contractIrText: '{}',
    expectedRepository: 'example/widget-api',
    expectedHeadSha: 'e'.repeat(40),
    allowedProducerCommits: ['f'.repeat(40)],
  });
}

test('module-local admission brand does not survive structured cloning', () => {
  const result = failedAdmission();

  assert.equal(result.status, 'failed');
  assert.equal(isLocallyVerifiedContractProjectionAdmission(result), true);
  assert.equal(isLocallyVerifiedContractProjectionAdmission(structuredClone(result)), false);
});

test('branded admission result graph is immutable after verification', () => {
  const result = failedAdmission();

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(Object.isFrozen(result.findings[0]), true);
  assert.throws(() => {
    result.headSha = '9'.repeat(40);
  }, TypeError);
  assert.throws(() => {
    result.findings[0].code = 'forged';
  }, TypeError);
  assert.equal(isLocallyVerifiedContractProjectionAdmission(result), true);
});
