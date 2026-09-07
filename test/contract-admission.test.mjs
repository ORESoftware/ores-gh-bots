import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CONTRACT_PROJECTION_ADMISSION_SCHEMA,
  CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
  verifyContractProjectionAdmission,
} from '../packages/core/src/contract-admission.mjs';
import { evaluateGate } from '../packages/core/src/gate.mjs';

const SET_LIKE_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'enum', 'oneOf', 'required', 'type']);
const hex = (character, length = 64) => character.repeat(length);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalize(value, parentKey = '') {
  if (Array.isArray(value)) {
    const values = value.map((item) => canonicalize(item, ''));
    if (SET_LIKE_ARRAY_KEYS.has(parentKey)) {
      const byEncoding = new Map(values.map((item) => [JSON.stringify(item), item]));
      return [...byEncoding.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, item]) => item);
    }
    return values;
  }
  if (value === null || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], key);
  return result;
}

const canonicalDigest = (value) => sha256(JSON.stringify(canonicalize(value)));
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

function makeFixture() {
  const reportFiles = {
    typespec: [{ path: '/repo/contracts/main.tsp', relativePath: 'main.tsp', sha256: hex('1') }],
    generatedJsonSchema: [{
      path: '/repo/generated/schema.json', relativePath: 'schema.json', sha256: hex('2'), document: {},
    }],
    authoredJsonSchema: [{
      path: '/repo/contracts/authored.schema.json', relativePath: 'authored.schema.json', sha256: hex('3'), document: {},
    }],
  };
  const report = {
    schema: 'ores.typespec-json-schema-validator.report/v1',
    runId: hex('d'),
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
      typespec: { input: 'contracts/main.tsp', digest: hex('a'), files: reportFiles.typespec },
      generatedJsonSchema: {
        input: 'generated/schema.json', digest: hex('b'), files: reportFiles.generatedJsonSchema,
      },
      authoredJsonSchema: {
        input: 'contracts/authored.schema.json', digest: hex('c'), files: reportFiles.authoredJsonSchema,
      },
    },
    declarationMap: [{
      typespec: 'Example.User', kind: 'model', generated: 'User', authored: 'User',
    }],
    toolchain: { validator: { version: '0.1.0' } },
    configuration: { mode: 'check' },
    differential: {
      summary: {
        comparedDeclarations: 1,
        probesEvaluated: 4,
        agreements: 4,
        divergences: 0,
        refusals: 0,
      },
    },
  };
  const assertionSchema = {
    additionalProperties: false,
    properties: { id: { type: 'string' } },
    required: ['id'],
    type: 'object',
    'x-typespec-name': 'Example.User',
  };
  const generatedSchema = {
    ...structuredClone(assertionSchema),
    title: 'Generated User',
  };
  const authoredSchema = {
    ...structuredClone(assertionSchema),
    description: 'Authored User',
  };
  const body = {
    schema: 'ores.typespec-json-schema-validator.contract-ir/v1',
    status: 'passed',
    admissible: true,
    role: 'downstream-derived-parity-artifact',
    editableAuthority: false,
    authorities: {
      typespec: 'independently-authored',
      jsonSchema: 'independently-authored',
      generatedJsonSchema: 'comparison-evidence-only',
      precedence: 'none',
    },
    admission: {
      receipt: {
        schema: report.schema,
        runId: report.runId,
        digest: canonicalDigest(report),
        status: 'passed',
        zeroUnexplainedFindings: true,
      },
      requirements: {
        exactInputDigests: true,
        directDeclarationInventory: true,
        generatedSchemaComparison: true,
        differentialInstanceValidation: true,
        zeroUnexplainedFindings: true,
      },
      scope: {
        admittedDeclarations: 1,
        excludedDeclarations: 0,
        outOfScopeDeclarations: 0,
        complete: true,
      },
    },
    provenance: {
      typespec: {
        role: 'independently-authored-authority',
        digest: report.inputs.typespec.digest,
        files: [{ path: 'main.tsp', sha256: hex('1') }],
      },
      generatedJsonSchema: {
        role: 'comparison-evidence-only',
        digest: report.inputs.generatedJsonSchema.digest,
        files: [{ path: 'schema.json', sha256: hex('2') }],
      },
      authoredJsonSchema: {
        role: 'independently-authored-authority',
        digest: report.inputs.authoredJsonSchema.digest,
        files: [{ path: 'authored.schema.json', sha256: hex('3') }],
      },
    },
    toolchain: structuredClone(report.toolchain),
    configuration: structuredClone(report.configuration),
    coverage: structuredClone(report.coverage),
    differential: structuredClone(report.differential.summary),
    declarations: [{
      id: 'Example.User',
      kind: 'model',
      names: {
        typespec: 'Example.User',
        generatedJsonSchema: 'User',
        authoredJsonSchema: 'User',
      },
      sources: {
        typespec: { file: 'main.tsp', line: 2, column: 1 },
        generatedJsonSchema: { file: 'schema.json', pointer: '#/$defs/User' },
        authoredJsonSchema: { file: 'authored.schema.json', pointer: '#/$defs/User' },
      },
      assertionSchema,
      assertionDigest: canonicalDigest(assertionSchema),
      lanes: {
        typespecGeneratedJsonSchema: {
          role: 'comparison-evidence-only',
          name: 'User',
          kind: 'model',
          schemaDigest: canonicalDigest(generatedSchema),
          normalizedSchema: generatedSchema,
        },
        authoredJsonSchema: {
          role: 'independently-authored-authority',
          name: 'User',
          kind: 'model',
          schemaDigest: canonicalDigest(authoredSchema),
          normalizedSchema: authoredSchema,
        },
      },
    }],
    excludedDeclarations: [],
    outOfScopeDeclarations: [],
  };
  const contractIr = { ...body, irId: canonicalDigest(body) };
  const reportText = jsonText(report);
  const contractIrText = jsonText(contractIr);
  const manifest = {
    schema: CONTRACT_PROJECTION_ADMISSION_SCHEMA,
    repository: 'example/widget-api',
    headSha: hex('e', 40),
    producer: {
      repository: 'ORESoftware/typespec-json-schema-validator',
      commit: hex('f', 40),
      reportSha256: sha256(reportText),
      contractIrSha256: sha256(contractIrText),
    },
    inputs: {
      typespec: report.inputs.typespec.digest,
      generatedJsonSchema: report.inputs.generatedJsonSchema.digest,
      authoredJsonSchema: report.inputs.authoredJsonSchema.digest,
    },
    projection: {
      kind: 'protobuf',
      outputDigest: hex('4'),
      configurationDigest: hex('5'),
      lossLedgerDigest: hex('6'),
      fieldLockDigest: hex('7'),
      operationInventoryDigest: null,
      runtimeValidatorRequired: false,
      runtimeValidatorEvidenceDigest: null,
    },
    validation: {
      compilerEvidenceDigest: hex('8'),
      fixtureEvidenceDigest: hex('9'),
      siblingTestRepository: 'example-test/widget-api-e2e',
      siblingTestCommit: hex('a', 40),
      siblingTestEvidenceDigest: hex('0'),
    },
  };
  return { manifest, report, contractIr, reportText, contractIrText };
}

function refreshIr(fixture) {
  const body = structuredClone(fixture.contractIr);
  delete body.irId;
  fixture.contractIr = { ...body, irId: canonicalDigest(body) };
  fixture.contractIrText = jsonText(fixture.contractIr);
  fixture.manifest.producer.contractIrSha256 = sha256(fixture.contractIrText);
}

function verify(fixture, overrides = {}) {
  return verifyContractProjectionAdmission({
    manifest: fixture.manifest,
    reportText: fixture.reportText,
    contractIrText: fixture.contractIrText,
    expectedRepository: 'example/widget-api',
    expectedHeadSha: hex('e', 40),
    allowedProducerCommits: [hex('f', 40)],
    ...overrides,
  });
}

function expectFailure(name, mutate, code, overrides = {}) {
  test(name, () => {
    const fixture = makeFixture();
    mutate(fixture);
    const result = verify(fixture, overrides);
    assert.equal(result.status, 'failed');
    assert.equal(result.admissible, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].code, code);
  });
}

test('admits exact peer-authority Contract IR evidence', () => {
  const fixture = makeFixture();
  const result = verify(fixture);
  assert.equal(result.schema, CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA);
  assert.equal(result.status, 'passed');
  assert.equal(result.admissible, true);
  assert.equal(result.projectionKind, 'protobuf');
  assert.equal(result.reportRunId, fixture.report.runId);
  assert.equal(result.contractIrId, fixture.contractIr.irId);
  assert.deepEqual(result.findings, []);
});

expectFailure('rejects a consumer repository mismatch', () => {}, 'repository_mismatch', {
  expectedRepository: 'other/widget-api',
});
expectFailure('rejects a moved PR head', () => {}, 'head_sha_mismatch', {
  expectedHeadSha: hex('b', 40),
});
expectFailure('requires a reviewed producer commit allowlist', () => {}, 'producer_allowlist_missing', {
  allowedProducerCommits: [],
});
expectFailure('rejects an unreviewed producer commit', () => {}, 'producer_commit_not_allowed', {
  allowedProducerCommits: [hex('c', 40)],
});
expectFailure('rejects a noncanonical producer repository', (fixture) => {
  fixture.manifest.producer.repository = 'other/validator';
}, 'producer_repository_mismatch');
expectFailure('rejects extra manifest authority', (fixture) => {
  fixture.manifest.bypass = true;
}, 'invalid_manifest');

expectFailure('binds the exact report bytes, including whitespace', (fixture) => {
  fixture.reportText = ` ${fixture.reportText}`;
}, 'report_raw_digest_mismatch');
expectFailure('binds the exact Contract IR bytes, including whitespace', (fixture) => {
  fixture.contractIrText = ` ${fixture.contractIrText}`;
}, 'contract_ir_raw_digest_mismatch');
expectFailure('rejects oversized artifacts before parsing', () => {}, 'artifact_size', {
  maxArtifactBytes: 1024,
});
expectFailure('rejects malformed report JSON', (fixture) => {
  fixture.reportText = '{ not-json';
  fixture.manifest.producer.reportSha256 = sha256(fixture.reportText);
}, 'artifact_json');

expectFailure('rejects a copied passed status with findings', (fixture) => {
  fixture.report.findings.push({ ruleId: 'TSJSV.TEST' });
  fixture.reportText = jsonText(fixture.report);
  fixture.manifest.producer.reportSha256 = sha256(fixture.reportText);
}, 'report_findings_not_empty');
expectFailure('rejects a stopped report', (fixture) => {
  fixture.report.status = 'stopped_for_evaluation';
  fixture.reportText = jsonText(fixture.report);
  fixture.manifest.producer.reportSha256 = sha256(fixture.reportText);
}, 'report_not_passed');
expectFailure('rejects missing differential execution', (fixture) => {
  fixture.report.coverage.differentialInstanceValidation = false;
  fixture.reportText = jsonText(fixture.report);
  fixture.manifest.producer.reportSha256 = sha256(fixture.reportText);
}, 'report_coverage_missing');
expectFailure('rejects duplicate report declaration identities', (fixture) => {
  fixture.report.declarationMap.push(structuredClone(fixture.report.declarationMap[0]));
  fixture.reportText = jsonText(fixture.report);
  fixture.manifest.producer.reportSha256 = sha256(fixture.reportText);
}, 'duplicate_declaration_map_identity');

expectFailure('rejects a receipt bound to a different run', (fixture) => {
  fixture.contractIr.admission.receipt.runId = hex('1');
  refreshIr(fixture);
}, 'receipt_run_id_mismatch');
expectFailure('rejects a receipt bound to a different report body', (fixture) => {
  fixture.contractIr.admission.receipt.digest = hex('1');
  refreshIr(fixture);
}, 'receipt_digest_mismatch');
expectFailure('rejects Contract IR self-digest tampering', (fixture) => {
  fixture.contractIr.irId = hex('1');
  fixture.contractIrText = jsonText(fixture.contractIr);
  fixture.manifest.producer.contractIrSha256 = sha256(fixture.contractIrText);
}, 'contract_ir_self_digest_mismatch');
expectFailure('rejects source-authority precedence', (fixture) => {
  fixture.contractIr.authorities.precedence = 'typespec';
  refreshIr(fixture);
}, 'authority_role_mismatch');
expectFailure('rejects a generated schema promoted to authority', (fixture) => {
  fixture.contractIr.authorities.generatedJsonSchema = 'independently-authored';
  refreshIr(fixture);
}, 'authority_role_mismatch');
expectFailure('rejects stale provenance input digests', (fixture) => {
  fixture.contractIr.provenance.typespec.digest = hex('4');
  refreshIr(fixture);
}, 'input_digest_mismatch');
expectFailure('rejects mismatched provenance files', (fixture) => {
  fixture.contractIr.provenance.typespec.files[0].sha256 = hex('4');
  refreshIr(fixture);
}, 'input_file_mismatch');
expectFailure('rejects unsafe provenance paths', (fixture) => {
  fixture.contractIr.provenance.typespec.files[0].path = '../main.tsp';
  refreshIr(fixture);
}, 'invalid_input_files');

expectFailure('rejects inconsistent scope counts', (fixture) => {
  fixture.contractIr.admission.scope.admittedDeclarations = 2;
  refreshIr(fixture);
}, 'scope_count_mismatch');
expectFailure('rejects an incomplete scope by default', (fixture) => {
  fixture.contractIr.excludedDeclarations.push({
    authority: 'typespec',
    id: 'Example.Internal',
    kind: 'model',
    source: { file: 'main.tsp', line: 8, column: 1 },
  });
  fixture.contractIr.admission.scope.excludedDeclarations = 1;
  fixture.contractIr.admission.scope.complete = false;
  refreshIr(fixture);
}, 'incomplete_scope');

test('allows explicitly reviewed incomplete scope without claiming completeness', () => {
  const fixture = makeFixture();
  fixture.contractIr.excludedDeclarations.push({
    authority: 'typespec',
    id: 'Example.Internal',
    kind: 'model',
    source: { file: 'main.tsp', line: 8, column: 1 },
  });
  fixture.contractIr.admission.scope.excludedDeclarations = 1;
  fixture.contractIr.admission.scope.complete = false;
  refreshIr(fixture);
  const result = verify(fixture, { requireCompleteScope: false });
  assert.equal(result.status, 'passed');
});

expectFailure('rejects duplicate Contract IR declarations', (fixture) => {
  fixture.contractIr.declarations.push(structuredClone(fixture.contractIr.declarations[0]));
  fixture.contractIr.admission.scope.admittedDeclarations = 2;
  refreshIr(fixture);
}, 'duplicate_declaration');
expectFailure('rejects assertion-schema tampering', (fixture) => {
  fixture.contractIr.declarations[0].assertionSchema.type = 'string';
  refreshIr(fixture);
}, 'assertion_digest_mismatch');
expectFailure('rejects lane-schema tampering', (fixture) => {
  fixture.contractIr.declarations[0].lanes.authoredJsonSchema.normalizedSchema.type = 'string';
  refreshIr(fixture);
}, 'lane_digest_mismatch');
expectFailure('rejects a Contract IR declaration map not present in the report', (fixture) => {
  fixture.contractIr.declarations[0].names.authoredJsonSchema = 'OtherUser';
  refreshIr(fixture);
}, 'declaration_map_mismatch');
expectFailure('rejects report/IR coverage drift', (fixture) => {
  fixture.contractIr.coverage.extra = true;
  refreshIr(fixture);
}, 'coverage_mismatch');
expectFailure('rejects manifest input digest drift', (fixture) => {
  fixture.manifest.inputs.authoredJsonSchema = hex('4');
}, 'manifest_input_digest_mismatch');

expectFailure('requires protobuf field-lock evidence', (fixture) => {
  fixture.manifest.projection.fieldLockDigest = null;
}, 'field_lock_required');
expectFailure('requires gRPC operation-inventory evidence', (fixture) => {
  fixture.manifest.projection.kind = 'grpc';
  fixture.manifest.projection.operationInventoryDigest = null;
}, 'operation_inventory_required');
expectFailure('requires tRPC operation-inventory evidence', (fixture) => {
  fixture.manifest.projection.kind = 'trpc';
  fixture.manifest.projection.fieldLockDigest = null;
  fixture.manifest.projection.operationInventoryDigest = null;
}, 'operation_inventory_required');
expectFailure('requires executed runtime-validator evidence when losses demand it', (fixture) => {
  fixture.manifest.projection.runtimeValidatorRequired = true;
}, 'runtime_validator_evidence_required');
expectFailure('rejects unsupported projection kinds', (fixture) => {
  fixture.manifest.projection.kind = 'business-logic';
}, 'unsupported_projection_kind');
expectFailure('rejects mutable sibling test revisions', (fixture) => {
  fixture.manifest.validation.siblingTestCommit = 'main';
}, 'invalid_validation_evidence');

test('published manifest schema is Draft 2020-12 and closed', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(
    await readFile(new URL('../config/contract-projection-admission.schema.json', import.meta.url), 'utf8'),
  );
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.properties.schema.const, CONTRACT_PROJECTION_ADMISSION_SCHEMA);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.projection.properties.kind.enum.includes('protobuf'));
  assert.ok(schema.properties.projection.properties.kind.enum.includes('trpc'));
});

const goodReview = { verdict: 'approve' };

test('gate behavior is unchanged when no projection evidence is required', () => {
  const result = evaluateGate({
    reviews: { openai: goodReview, claude: goodReview },
    ci: [{ context: 'ci/verify', state: 'success', appId: 42 }],
    requiredCiContexts: ['ci/verify'],
    requiredCiAppIds: { 'ci/verify': 42 },
  });
  assert.equal(result.conclusion, 'success');
  assert.deepEqual(result.projectionStates, []);
});

test('gate keeps required projection evidence pending until supplied', () => {
  const result = evaluateGate({
    reviews: { openai: goodReview, claude: goodReview },
    requiredProjectionKinds: ['protobuf'],
  });
  assert.equal(result.status, 'in_progress');
  assert.equal(result.projectionStates[0].state, 'pending');
});

test('gate accepts one exact verifier result for each required projection', () => {
  const admission = verify(makeFixture());
  const result = evaluateGate({
    reviews: { openai: goodReview, claude: goodReview },
    projectionAdmissions: [admission],
    requiredProjectionKinds: ['protobuf'],
  });
  assert.equal(result.conclusion, 'success');
  assert.equal(result.projectionStates[0].state, 'success');
});

test('gate rejects failed or duplicated projection evidence', () => {
  const fixture = makeFixture();
  fixture.manifest.headSha = hex('1', 40);
  const failed = verify(fixture);
  const failedGate = evaluateGate({
    reviews: { openai: goodReview, claude: goodReview },
    projectionAdmissions: [failed],
    requiredProjectionKinds: ['protobuf'],
  });
  assert.equal(failedGate.conclusion, 'failure');

  const passed = verify(makeFixture());
  const duplicateGate = evaluateGate({
    reviews: { openai: goodReview, claude: goodReview },
    projectionAdmissions: [passed, structuredClone(passed)],
    requiredProjectionKinds: ['protobuf'],
  });
  assert.equal(duplicateGate.conclusion, 'failure');
  assert.equal(duplicateGate.projectionStates[0].reason, 'duplicate admission evidence');
});
