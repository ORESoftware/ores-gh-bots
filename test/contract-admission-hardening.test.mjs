import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CONTRACT_PROJECTION_ADMISSION_SCHEMA,
  CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
  verifyContractProjectionAdmission,
} from '../packages/core/src/contract-admission.mjs';
import { evaluateGate } from '../packages/core/src/gate.mjs';

const hex = (character, length = 64) => character.repeat(length);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const repository = 'example/widget-api';
const headSha = hex('e', 40);
const producerCommit = hex('f', 40);

function manifestFor(reportText, contractIrText) {
  return {
    schema: CONTRACT_PROJECTION_ADMISSION_SCHEMA,
    repository,
    headSha,
    producer: {
      repository: 'ORESoftware/typespec-json-schema-validator',
      commit: producerCommit,
      reportSha256: sha256(reportText),
      contractIrSha256: sha256(contractIrText),
    },
    inputs: {
      typespec: hex('a'),
      generatedJsonSchema: hex('b'),
      authoredJsonSchema: hex('c'),
    },
    projection: {
      kind: 'sql',
      outputDigest: hex('1'),
      configurationDigest: hex('2'),
      lossLedgerDigest: hex('3'),
      fieldLockDigest: null,
      operationInventoryDigest: null,
      runtimeValidatorRequired: false,
      runtimeValidatorEvidenceDigest: null,
    },
    validation: {
      compilerEvidenceDigest: hex('4'),
      fixtureEvidenceDigest: hex('5'),
      siblingTestRepository: 'example-test/widget-api-e2e',
      siblingTestCommit: hex('6', 40),
      siblingTestEvidenceDigest: hex('7'),
    },
  };
}

function verifyRaw(reportText, contractIrText = '{}', overrides = {}) {
  return verifyContractProjectionAdmission({
    manifest: manifestFor(reportText, contractIrText),
    reportText,
    contractIrText,
    expectedRepository: repository,
    expectedHeadSha: headSha,
    allowedProducerCommits: [producerCommit],
    ...overrides,
  });
}

function validReport(overrides = {}) {
  const file = (path, digest) => ({ path, relativePath: path, sha256: digest });
  return {
    schema: 'ores.typespec-json-schema-validator.report/v1',
    runId: hex('8'),
    status: 'passed',
    zeroUnexplainedFindings: true,
    findings: [],
    authorities: {
      typespec: 'independently-authored',
      jsonSchema: 'independently-authored',
      generatedJsonSchema: 'comparison-evidence-only',
      precedence: 'none',
    },
    coverage: {
      directDeclarationInventory: true,
      typespecGeneratedJsonSchemaComparison: true,
      differentialInstanceValidation: true,
    },
    inputs: {
      typespec: { digest: hex('a'), files: [file('main.tsp', hex('1'))] },
      generatedJsonSchema: { digest: hex('b'), files: [file('generated.json', hex('2'))] },
      authoredJsonSchema: { digest: hex('c'), files: [file('authored.json', hex('3'))] },
    },
    declarationMap: [],
    ...overrides,
  };
}

function expectCode(result, code) {
  assert.equal(result.status, 'failed');
  assert.equal(result.admissible, false);
  assert.equal(result.findings[0]?.code, code);
}

test('rejects duplicate JSON keys before semantic validation', () => {
  expectCode(verifyRaw('{"schema":"one","schema":"two"}'), 'artifact_duplicate_key');
});

test('rejects excessive JSON nesting before canonicalization', () => {
  const reportText = `${'['.repeat(129)}0${']'.repeat(129)}`;
  expectCode(verifyRaw(reportText), 'artifact_depth');
});

test('rejects report-level authority inversion', () => {
  const report = validReport();
  report.authorities.precedence = 'typespec';
  expectCode(verifyRaw(`${JSON.stringify(report)}\n`), 'report_authority_mismatch');
});

test('requires sibling evidence from a distinct repository', () => {
  const reportText = '{}';
  const contractIrText = '{}';
  const manifest = manifestFor(reportText, contractIrText);
  manifest.validation.siblingTestRepository = repository;
  const result = verifyContractProjectionAdmission({
    manifest,
    reportText,
    contractIrText,
    expectedRepository: repository,
    expectedHeadSha: headSha,
    allowedProducerCommits: [producerCommit],
  });
  expectCode(result, 'sibling_test_repository_not_distinct');
});

function admittedResult() {
  return {
    schema: CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
    repository,
    headSha,
    projectionKind: 'sql',
    manifestDigest: hex('1'),
    reportRunId: hex('2'),
    contractIrId: hex('3'),
    status: 'passed',
    admissible: true,
    findings: [],
  };
}

const reviews = {
  openai: { verdict: 'approve' },
  claude: { verdict: 'approve' },
};

test('gate fails closed when required projection context is absent', () => {
  const result = evaluateGate({
    reviews,
    projectionAdmissions: [admittedResult()],
    requiredProjectionKinds: ['sql'],
  });
  assert.equal(result.conclusion, 'failure');
  assert.match(result.projectionStates[0].reason, /context is missing or invalid/u);
});

test('gate rejects a serialized admission from an earlier head', () => {
  const admission = admittedResult();
  admission.headSha = hex('9', 40);
  const result = evaluateGate({
    reviews,
    projectionAdmissions: [admission],
    requiredProjectionKinds: ['sql'],
    projectionContext: { repository, headSha },
  });
  assert.equal(result.conclusion, 'failure');
  assert.equal(result.projectionStates[0].reason, 'admission head SHA is stale or mismatched');
});

test('gate rejects duplicate required projection kinds', () => {
  const result = evaluateGate({
    reviews,
    projectionAdmissions: [admittedResult()],
    requiredProjectionKinds: ['sql', 'sql'],
    projectionContext: { repository, headSha },
  });
  assert.equal(result.conclusion, 'failure');
  assert.ok(result.projectionStates.every((state) => state.reason === 'duplicate projection requirement'));
});
