import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_ADMISSION_POLICY_SCHEMA,
  contractAdmissionPolicyForRepository,
  loadContractAdmissionPolicyFile,
  parseContractAdmissionPolicy,
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

test('validates, sorts, and freezes trusted repository policy', () => {
  const input = policy();
  input.repositories[0].producer.allowedCommits.push('0'.repeat(40));
  input.repositories[0].projections.push({
    kind: 'dart',
    manifestPath: 'contracts/evidence/dart-admission.json',
    requireCompleteScope: false,
  });
  const validated = validateContractAdmissionPolicy(input);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.repositories[0].producer.allowedCommits), true);
  assert.deepEqual(validated.repositories[0].producer.allowedCommits, ['0'.repeat(40), '1'.repeat(40)]);
  assert.deepEqual(validated.repositories[0].projections.map((item) => item.kind), ['dart', 'protobuf']);
  assert.equal(
    contractAdmissionPolicyForRepository(validated, 'EXAMPLE-TEST/WIDGET-API')?.repository,
    'example-test/widget-api',
  );
});

test('loads the disabled example without activating a repository', () => {
  const path = fileURLToPath(new URL('../config/contract-admission-policy.example.json', import.meta.url));
  const loaded = loadContractAdmissionPolicyFile(path);
  assert.equal(loaded.schema, CONTRACT_ADMISSION_POLICY_SCHEMA);
  assert.equal(contractAdmissionPolicyForRepository(loaded, 'example-test/widget-api'), null);
});

test('rejects duplicate policy JSON keys', () => {
  assert.throws(
    () => parseContractAdmissionPolicy('{"schema":"one","schema":"two","repositories":[]}'),
    (error) => error?.code === 'artifact_duplicate_key',
  );
});

test('rejects duplicate repositories, projection kinds, and producer commits', () => {
  const duplicateRepository = policy();
  duplicateRepository.repositories.push(structuredClone(duplicateRepository.repositories[0]));
  assert.throws(() => validateContractAdmissionPolicy(duplicateRepository), /duplicate repository policy/u);

  const duplicateProjection = policy();
  duplicateProjection.repositories[0].projections.push(structuredClone(duplicateProjection.repositories[0].projections[0]));
  assert.throws(() => validateContractAdmissionPolicy(duplicateProjection), /repeats projection kind/u);

  const duplicateCommit = policy();
  duplicateCommit.repositories[0].producer.allowedCommits.push('1'.repeat(40));
  assert.throws(() => validateContractAdmissionPolicy(duplicateCommit), /contains duplicates/u);
});

test('rejects ORES-owned producer checks and unsafe or reused paths', () => {
  const ownCheck = policy();
  ownCheck.repositories[0].producer.checkName = 'ores-review/gate';
  assert.throws(() => validateContractAdmissionPolicy(ownCheck), /cannot reuse/u);

  const traversal = policy();
  traversal.repositories[0].artifacts.reportPath = '../parity-report.json';
  assert.throws(() => validateContractAdmissionPolicy(traversal), /unsafe path segment/u);

  const reused = policy();
  reused.repositories[0].projections[0].manifestPath = reused.repositories[0].artifacts.reportPath;
  assert.throws(() => validateContractAdmissionPolicy(reused), /not unique/u);
});

test('policy loader rejects symbolic links and hard links', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ores-contract-policy-'));
  try {
    const target = join(directory, 'policy.json');
    const hardLink = join(directory, 'hard.json');
    const symbolicLink = join(directory, 'symbolic.json');
    writeFileSync(target, `${JSON.stringify(policy())}\n`);
    linkSync(target, hardLink);
    symlinkSync(target, symbolicLink);
    assert.throws(() => loadContractAdmissionPolicyFile(target), /regular, non-linked file/u);
    assert.throws(() => loadContractAdmissionPolicyFile(hardLink), /regular, non-linked file/u);
    assert.throws(() => loadContractAdmissionPolicyFile(symbolicLink), /regular, non-linked file/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
