import {
  FIELD_LOCK_KINDS,
  OPERATION_INVENTORY_KINDS,
  PROJECTION_KINDS,
} from './constants.mjs';
import {
  fail,
  requireBoolean,
  requireExactKeys,
  requireHex160,
  requireHex256,
  requireNullableHex256,
  requireRepository,
} from './common.mjs';

export function validateManifest(manifest, expectedRepository, expectedHeadSha, allowedProducerCommits) {
  const value = requireExactKeys(
    manifest,
    ['schema', 'repository', 'headSha', 'producer', 'inputs', 'projection', 'validation'],
    new Set(['schema', 'repository', 'headSha', 'producer', 'inputs', 'projection', 'validation']),
    'invalid_manifest',
    'manifest',
  );
  if (value.schema !== 'ores.gh-bots.contract-projection-admission/v1') {
    fail('invalid_manifest_schema', 'manifest schema is unsupported');
  }
  requireRepository(value.repository, 'invalid_manifest', 'manifest.repository');
  requireHex160(value.headSha, 'invalid_manifest', 'manifest.headSha');
  requireRepository(expectedRepository, 'invalid_expectation', 'expectedRepository');
  requireHex160(expectedHeadSha, 'invalid_expectation', 'expectedHeadSha');
  if (value.repository !== expectedRepository) {
    fail('repository_mismatch', `manifest repository ${value.repository} does not match ${expectedRepository}`);
  }
  if (value.headSha !== expectedHeadSha) {
    fail('head_sha_mismatch', `manifest head ${value.headSha} does not match ${expectedHeadSha}`);
  }

  const producer = requireExactKeys(
    value.producer,
    ['repository', 'commit', 'reportSha256', 'contractIrSha256'],
    new Set(['repository', 'commit', 'reportSha256', 'contractIrSha256']),
    'invalid_manifest',
    'manifest.producer',
  );
  requireRepository(producer.repository, 'invalid_manifest', 'manifest.producer.repository');
  requireHex160(producer.commit, 'invalid_manifest', 'manifest.producer.commit');
  requireHex256(producer.reportSha256, 'invalid_manifest', 'manifest.producer.reportSha256');
  requireHex256(producer.contractIrSha256, 'invalid_manifest', 'manifest.producer.contractIrSha256');
  if (producer.repository !== 'ORESoftware/typespec-json-schema-validator') {
    fail('producer_repository_mismatch', 'producer repository is not the canonical validator');
  }
  if (!Array.isArray(allowedProducerCommits) || allowedProducerCommits.length === 0) {
    fail('producer_allowlist_missing', 'at least one reviewed producer commit is required');
  }
  if (allowedProducerCommits.length > 64) {
    fail('invalid_expectation', 'allowedProducerCommits exceeds the maximum of 64 entries');
  }
  if (!allowedProducerCommits.every((commit) => /^[a-f0-9]{40}$/u.test(commit))) {
    fail('invalid_expectation', 'allowedProducerCommits contains an invalid commit');
  }
  if (new Set(allowedProducerCommits).size !== allowedProducerCommits.length) {
    fail('invalid_expectation', 'allowedProducerCommits contains duplicates');
  }
  if (!allowedProducerCommits.includes(producer.commit)) {
    fail('producer_commit_not_allowed', `producer commit ${producer.commit} is not reviewed`);
  }

  const inputs = requireExactKeys(
    value.inputs,
    ['typespec', 'generatedJsonSchema', 'authoredJsonSchema'],
    new Set(['typespec', 'generatedJsonSchema', 'authoredJsonSchema']),
    'invalid_manifest',
    'manifest.inputs',
  );
  for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
    requireHex256(inputs[lane], 'invalid_manifest', `manifest.inputs.${lane}`);
  }

  const projectionKeys = [
    'kind',
    'outputDigest',
    'configurationDigest',
    'lossLedgerDigest',
    'fieldLockDigest',
    'operationInventoryDigest',
    'runtimeValidatorRequired',
    'runtimeValidatorEvidenceDigest',
  ];
  const projection = requireExactKeys(
    value.projection,
    projectionKeys,
    new Set(projectionKeys),
    'invalid_manifest',
    'manifest.projection',
  );
  if (!PROJECTION_KINDS.has(projection.kind)) {
    fail('unsupported_projection_kind', `unsupported projection kind ${projection.kind ?? 'none'}`);
  }
  requireHex256(projection.outputDigest, 'invalid_projection_evidence', 'projection.outputDigest');
  requireHex256(projection.configurationDigest, 'invalid_projection_evidence', 'projection.configurationDigest');
  requireHex256(projection.lossLedgerDigest, 'invalid_projection_evidence', 'projection.lossLedgerDigest');
  requireNullableHex256(projection.fieldLockDigest, 'invalid_projection_evidence', 'projection.fieldLockDigest');
  requireNullableHex256(
    projection.operationInventoryDigest,
    'invalid_projection_evidence',
    'projection.operationInventoryDigest',
  );
  requireBoolean(
    projection.runtimeValidatorRequired,
    'invalid_projection_evidence',
    'projection.runtimeValidatorRequired',
  );
  requireNullableHex256(
    projection.runtimeValidatorEvidenceDigest,
    'invalid_projection_evidence',
    'projection.runtimeValidatorEvidenceDigest',
  );
  if (FIELD_LOCK_KINDS.has(projection.kind) && projection.fieldLockDigest === null) {
    fail('field_lock_required', `${projection.kind} projection requires field-lock evidence`);
  }
  if (OPERATION_INVENTORY_KINDS.has(projection.kind) && projection.operationInventoryDigest === null) {
    fail('operation_inventory_required', `${projection.kind} projection requires operation-inventory evidence`);
  }
  if (projection.runtimeValidatorRequired && projection.runtimeValidatorEvidenceDigest === null) {
    fail('runtime_validator_evidence_required', 'required runtime validator has no execution evidence');
  }

  const validationKeys = [
    'compilerEvidenceDigest',
    'fixtureEvidenceDigest',
    'siblingTestRepository',
    'siblingTestCommit',
    'siblingTestEvidenceDigest',
  ];
  const validation = requireExactKeys(
    value.validation,
    validationKeys,
    new Set(validationKeys),
    'invalid_manifest',
    'manifest.validation',
  );
  requireHex256(validation.compilerEvidenceDigest, 'invalid_validation_evidence', 'validation.compilerEvidenceDigest');
  requireHex256(validation.fixtureEvidenceDigest, 'invalid_validation_evidence', 'validation.fixtureEvidenceDigest');
  requireRepository(validation.siblingTestRepository, 'invalid_validation_evidence', 'validation.siblingTestRepository');
  if (validation.siblingTestRepository === expectedRepository) {
    fail('sibling_test_repository_not_distinct', 'sibling test evidence must come from a distinct repository');
  }
  requireHex160(validation.siblingTestCommit, 'invalid_validation_evidence', 'validation.siblingTestCommit');
  requireHex256(
    validation.siblingTestEvidenceDigest,
    'invalid_validation_evidence',
    'validation.siblingTestEvidenceDigest',
  );
  return value;
}
