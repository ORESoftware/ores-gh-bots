import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_ADMISSION_POLICY_SCHEMA,
  validateContractAdmissionPolicy,
} from '../packages/core/src/contract-policy.mjs';

function policy() {
  return {
    schema: CONTRACT_ADMISSION_POLICY_SCHEMA,
    repositories: [{
      repository: 'example-test/widget-api',
      enabled: true,
      producer: {
        repository: 'ORESoftware/typespec-json-schema-validator',
        allowedCommits: ['1'.repeat(40)],
        checkName: 'contract-parity/verify',
        checkAppId: 12345,
        maxCheckAgeSeconds: 86400,
      },
      artifacts: {
        reportPath: 'contracts/evidence/parity-report.json',
        contractIrPath: 'contracts/evidence/contract-ir.json',
        maxArtifactBytes: 5 * 1024 * 1024,
      },
      projections: [{
        kind: 'protobuf',
        manifestPath: 'contracts/evidence/protobuf-admission.json',
        requireCompleteScope: true,
      }],
    }],
  };
}

test('rejects report, Contract IR, and manifest paths under reserved .ores', () => {
  for (const mutate of [
    (value) => { value.repositories[0].artifacts.reportPath = '.ores/contracts/report.json'; },
    (value) => { value.repositories[0].artifacts.contractIrPath = '.ores/contracts/ir.json'; },
    (value) => { value.repositories[0].projections[0].manifestPath = '.ores/contracts/manifest.json'; },
  ]) {
    const value = policy();
    mutate(value);
    assert.throws(
      () => validateContractAdmissionPolicy(value),
      /reserved, ignored \.ores workspace path/u,
    );
  }
});
