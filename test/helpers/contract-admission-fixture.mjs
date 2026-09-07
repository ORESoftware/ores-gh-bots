import { createHash } from 'node:crypto';
import { CONTRACT_ADMISSION_POLICY_SCHEMA } from '../../packages/core/src/contract-policy.mjs';
import { CONTRACT_PROJECTION_ADMISSION_SCHEMA } from '../../packages/core/src/contract-admission.mjs';

const SET_LIKE_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'enum', 'oneOf', 'required', 'type']);

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function makeContractAdmissionFixture({
  repository = 'O/R',
  headSha = 'a'.repeat(40),
  producerCommit = 'f'.repeat(40),
  producerCheckName = 'contract-parity/verify',
  producerCheckAppId = 12345,
} = {}) {
  const report = {
    schema: 'ores.typespec-json-schema-validator.report/v1',
    runId: 'd'.repeat(64),
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
      typespec: {
        input: 'contracts/main.tsp',
        digest: 'a'.repeat(64),
        files: [{ path: '/checkout/contracts/main.tsp', relativePath: 'main.tsp', sha256: '1'.repeat(64) }],
      },
      generatedJsonSchema: {
        input: 'generated/schema.json',
        digest: 'b'.repeat(64),
        files: [{ path: '/checkout/generated/schema.json', relativePath: 'schema.json', sha256: '2'.repeat(64) }],
      },
      authoredJsonSchema: {
        input: 'contracts/authored.schema.json',
        digest: 'c'.repeat(64),
        files: [{ path: '/checkout/contracts/authored.schema.json', relativePath: 'authored.schema.json', sha256: '3'.repeat(64) }],
      },
    },
    declarationMap: [{
      typespec: 'Example.User',
      kind: 'model',
      generated: 'User',
      authored: 'User',
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
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
    'x-typespec-name': 'Example.User',
  };
  const generatedSchema = { ...structuredClone(assertionSchema), title: 'Generated User' };
  const authoredSchema = { ...structuredClone(assertionSchema), description: 'Authored User' };
  const contractIrBody = {
    schema: 'ores.typespec-json-schema-validator.contract-ir/v1',
    status: 'passed',
    admissible: true,
    role: 'downstream-derived-parity-artifact',
    editableAuthority: false,
    authorities: structuredClone(report.authorities),
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
        files: [{ path: 'main.tsp', sha256: '1'.repeat(64) }],
      },
      generatedJsonSchema: {
        role: 'comparison-evidence-only',
        digest: report.inputs.generatedJsonSchema.digest,
        files: [{ path: 'schema.json', sha256: '2'.repeat(64) }],
      },
      authoredJsonSchema: {
        role: 'independently-authored-authority',
        digest: report.inputs.authoredJsonSchema.digest,
        files: [{ path: 'authored.schema.json', sha256: '3'.repeat(64) }],
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
  const contractIr = {
    ...contractIrBody,
    irId: canonicalDigest(contractIrBody),
  };
  const reportText = jsonText(report);
  const contractIrText = jsonText(contractIr);
  const manifest = {
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
      typespec: report.inputs.typespec.digest,
      generatedJsonSchema: report.inputs.generatedJsonSchema.digest,
      authoredJsonSchema: report.inputs.authoredJsonSchema.digest,
    },
    projection: {
      kind: 'protobuf',
      outputDigest: '4'.repeat(64),
      configurationDigest: '5'.repeat(64),
      lossLedgerDigest: '6'.repeat(64),
      fieldLockDigest: '7'.repeat(64),
      operationInventoryDigest: null,
      runtimeValidatorRequired: false,
      runtimeValidatorEvidenceDigest: null,
    },
    validation: {
      compilerEvidenceDigest: '8'.repeat(64),
      fixtureEvidenceDigest: '9'.repeat(64),
      siblingTestRepository: 'O-test/R-e2e',
      siblingTestCommit: 'e'.repeat(40),
      siblingTestEvidenceDigest: '0'.repeat(64),
    },
  };
  const manifestText = jsonText(manifest);
  const paths = {
    report: '.ores/contracts/parity-report.json',
    contractIr: '.ores/contracts/contract-ir.json',
    manifest: '.ores/contracts/protobuf-admission.json',
  };
  const policy = {
    schema: CONTRACT_ADMISSION_POLICY_SCHEMA,
    repositories: [{
      repository,
      enabled: true,
      producer: {
        repository: 'ORESoftware/typespec-json-schema-validator',
        allowedCommits: [producerCommit],
        checkName: producerCheckName,
        checkAppId: producerCheckAppId,
        maxCheckAgeSeconds: 86400,
      },
      artifacts: {
        reportPath: paths.report,
        contractIrPath: paths.contractIr,
        maxArtifactBytes: 5 * 1024 * 1024,
      },
      projections: [{
        kind: 'protobuf',
        manifestPath: paths.manifest,
        requireCompleteScope: true,
      }],
    }],
  };
  return {
    repository,
    headSha,
    producerCommit,
    producerCheckName,
    producerCheckAppId,
    report,
    contractIr,
    manifest,
    reportText,
    contractIrText,
    manifestText,
    paths,
    policy,
  };
}
