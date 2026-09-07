import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_ADMISSION_POLICY_SCHEMA,
  contractAdmissionPolicyForRepository,
  loadConfig,
} from '../packages/core/src/index.mjs';

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

test('runtime config loads one operator-owned policy file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ores-contract-policy-config-'));
  try {
    const path = join(directory, 'policy.json');
    writeFileSync(path, `${JSON.stringify(policy())}\n`, { mode: 0o600 });
    const config = loadConfig({ CONTRACT_ADMISSION_POLICY_PATH: path });
    assert.equal(config.contractAdmission.policyPath, path);
    assert.equal(
      contractAdmissionPolicyForRepository(
        config.contractAdmission.policy,
        'example-test/widget-api',
      )?.projections[0].kind,
      'protobuf',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('empty policy path preserves an immutable empty policy', () => {
  const config = loadConfig({});
  assert.equal(config.contractAdmission.policyPath, null);
  assert.equal(config.contractAdmission.policy.repositories.length, 0);
  assert.equal(Object.isFrozen(config.contractAdmission.policy), true);
});

test('runtime config fails closed when the configured policy file is missing', () => {
  assert.throws(
    () => loadConfig({ CONTRACT_ADMISSION_POLICY_PATH: '/definitely/missing/ores-contract-policy.json' }),
    /ENOENT/u,
  );
});
