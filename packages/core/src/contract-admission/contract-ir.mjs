import { CONTRACT_IR_SCHEMA, REPORT_SCHEMA } from './constants.mjs';
import {
  canonicalStringifyTsjsvV1,
  canonicalStringifyTsjsvV1OrNull,
  digestCanonical,
  fail,
  normalizeEvidenceFiles,
  requireArray,
  requireBoolean,
  requireBoundedText,
  requireExactKeys,
  requireHex256,
  requireNonNegativeInteger,
  requireSource,
  requireString,
} from './common.mjs';

function validateProvenanceLane(value, expectedRole, label) {
  const lane = requireExactKeys(
    value,
    ['role', 'digest', 'files'],
    new Set(['role', 'digest', 'files']),
    'invalid_contract_ir',
    label,
  );
  if (lane.role !== expectedRole) fail('authority_role_mismatch', `${label}.role is invalid`);
  requireHex256(lane.digest, 'invalid_contract_ir', `${label}.digest`);
  return { value: lane, files: normalizeEvidenceFiles(lane.files, label) };
}

function validateLane(value, expectedRole, label) {
  const lane = requireExactKeys(
    value,
    ['role', 'name', 'kind', 'schemaDigest', 'normalizedSchema'],
    new Set(['role', 'name', 'kind', 'schemaDigest', 'normalizedSchema']),
    'invalid_contract_ir',
    label,
  );
  if (lane.role !== expectedRole) fail('authority_role_mismatch', `${label}.role is invalid`);
  requireBoundedText(lane.name, 'invalid_contract_ir', `${label}.name`);
  requireString(lane.kind, 'invalid_contract_ir', `${label}.kind`);
  requireHex256(lane.schemaDigest, 'invalid_contract_ir', `${label}.schemaDigest`);
  if (digestCanonical(lane.normalizedSchema) !== lane.schemaDigest) {
    fail('lane_digest_mismatch', `${label}.schemaDigest does not match normalizedSchema`);
  }
}

export function validateContractIr(contractIr, reportEvidence, requireCompleteScope) {
  const allowedTopLevel = new Set([
    'schema',
    'irId',
    'status',
    'admissible',
    'role',
    'editableAuthority',
    'authorities',
    'admission',
    'provenance',
    'toolchain',
    'configuration',
    'coverage',
    'differential',
    'declarations',
    'excludedDeclarations',
    'outOfScopeDeclarations',
  ]);
  const value = requireExactKeys(
    contractIr,
    [
      'schema',
      'irId',
      'status',
      'admissible',
      'role',
      'editableAuthority',
      'authorities',
      'admission',
      'provenance',
      'declarations',
      'excludedDeclarations',
      'outOfScopeDeclarations',
    ],
    allowedTopLevel,
    'invalid_contract_ir',
    'contractIr',
  );
  if (value.schema !== CONTRACT_IR_SCHEMA) {
    fail('invalid_contract_ir_schema', `Contract IR schema must be ${CONTRACT_IR_SCHEMA}`);
  }
  requireHex256(value.irId, 'invalid_contract_ir', 'contractIr.irId');
  if (value.status !== 'passed' || value.admissible !== true) {
    fail('contract_ir_not_admissible', 'Contract IR must be passed and admissible');
  }
  if (value.role !== 'downstream-derived-parity-artifact' || value.editableAuthority !== false) {
    fail('contract_ir_authority_violation', 'Contract IR must remain immutable downstream evidence');
  }

  const authorities = requireExactKeys(
    value.authorities,
    ['typespec', 'jsonSchema', 'generatedJsonSchema', 'precedence'],
    new Set(['typespec', 'jsonSchema', 'generatedJsonSchema', 'precedence']),
    'invalid_contract_ir',
    'contractIr.authorities',
  );
  if (
    authorities.typespec !== 'independently-authored' ||
    authorities.jsonSchema !== 'independently-authored' ||
    authorities.generatedJsonSchema !== 'comparison-evidence-only' ||
    authorities.precedence !== 'none'
  ) {
    fail('authority_role_mismatch', 'Contract IR authority roles or precedence are invalid');
  }

  const admission = requireExactKeys(
    value.admission,
    ['receipt', 'requirements', 'scope'],
    new Set(['receipt', 'requirements', 'scope']),
    'invalid_contract_ir',
    'contractIr.admission',
  );
  const receipt = requireExactKeys(
    admission.receipt,
    ['schema', 'runId', 'digest', 'status', 'zeroUnexplainedFindings'],
    new Set(['schema', 'runId', 'digest', 'status', 'zeroUnexplainedFindings']),
    'invalid_contract_ir',
    'contractIr.admission.receipt',
  );
  if (receipt.schema !== REPORT_SCHEMA) fail('receipt_mismatch', 'receipt schema is invalid');
  requireHex256(receipt.runId, 'invalid_contract_ir', 'contractIr.admission.receipt.runId');
  requireHex256(receipt.digest, 'invalid_contract_ir', 'contractIr.admission.receipt.digest');
  if (receipt.status !== 'passed' || receipt.zeroUnexplainedFindings !== true) {
    fail('receipt_mismatch', 'receipt is not a zero-finding pass');
  }
  if (receipt.runId !== reportEvidence.value.runId) {
    fail('receipt_run_id_mismatch', 'Contract IR receipt runId does not match the report');
  }
  if (receipt.digest !== digestCanonical(reportEvidence.value)) {
    fail('receipt_digest_mismatch', 'Contract IR receipt digest does not match the exact report');
  }

  const requirementKeys = [
    'exactInputDigests',
    'directDeclarationInventory',
    'generatedSchemaComparison',
    'differentialInstanceValidation',
    'zeroUnexplainedFindings',
  ];
  const requirements = requireExactKeys(
    admission.requirements,
    requirementKeys,
    new Set(requirementKeys),
    'invalid_contract_ir',
    'contractIr.admission.requirements',
  );
  for (const [key, requirement] of Object.entries(requirements)) {
    if (requirement !== true) fail('admission_requirement_missing', `Contract IR requirement ${key} is not true`);
  }

  const scope = requireExactKeys(
    admission.scope,
    ['admittedDeclarations', 'excludedDeclarations', 'outOfScopeDeclarations', 'complete'],
    new Set(['admittedDeclarations', 'excludedDeclarations', 'outOfScopeDeclarations', 'complete']),
    'invalid_contract_ir',
    'contractIr.admission.scope',
  );
  requireNonNegativeInteger(scope.admittedDeclarations, 'invalid_contract_ir', 'scope.admittedDeclarations');
  requireNonNegativeInteger(scope.excludedDeclarations, 'invalid_contract_ir', 'scope.excludedDeclarations');
  requireNonNegativeInteger(scope.outOfScopeDeclarations, 'invalid_contract_ir', 'scope.outOfScopeDeclarations');
  requireBoolean(scope.complete, 'invalid_contract_ir', 'scope.complete');

  const provenance = requireExactKeys(
    value.provenance,
    ['typespec', 'generatedJsonSchema', 'authoredJsonSchema'],
    new Set(['typespec', 'generatedJsonSchema', 'authoredJsonSchema']),
    'invalid_contract_ir',
    'contractIr.provenance',
  );
  const provenanceEvidence = {
    typespec: validateProvenanceLane(
      provenance.typespec,
      'independently-authored-authority',
      'contractIr.provenance.typespec',
    ),
    generatedJsonSchema: validateProvenanceLane(
      provenance.generatedJsonSchema,
      'comparison-evidence-only',
      'contractIr.provenance.generatedJsonSchema',
    ),
    authoredJsonSchema: validateProvenanceLane(
      provenance.authoredJsonSchema,
      'independently-authored-authority',
      'contractIr.provenance.authoredJsonSchema',
    ),
  };
  for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
    if (provenanceEvidence[lane].value.digest !== reportEvidence.value.inputs[lane].digest) {
      fail('input_digest_mismatch', `Contract IR ${lane} digest does not match the report`);
    }
    if (
      canonicalStringifyTsjsvV1(provenanceEvidence[lane].files) !==
      canonicalStringifyTsjsvV1(reportEvidence.normalizedFiles[lane])
    ) {
      fail('input_file_mismatch', `Contract IR ${lane} file evidence does not match the report`);
    }
  }

  const declarations = requireArray(value.declarations, 'invalid_contract_ir', 'contractIr.declarations');
  const excluded = requireArray(value.excludedDeclarations, 'invalid_contract_ir', 'contractIr.excludedDeclarations');
  const outOfScope = requireArray(
    value.outOfScopeDeclarations,
    'invalid_contract_ir',
    'contractIr.outOfScopeDeclarations',
  );
  if (
    scope.admittedDeclarations !== declarations.length ||
    scope.excludedDeclarations !== excluded.length ||
    scope.outOfScopeDeclarations !== outOfScope.length
  ) {
    fail('scope_count_mismatch', 'Contract IR scope counts do not match its arrays');
  }
  const computedComplete = excluded.length === 0 && outOfScope.length === 0;
  if (scope.complete !== computedComplete) {
    fail('scope_completeness_mismatch', 'Contract IR scope completeness is inconsistent');
  }
  if (requireCompleteScope && !scope.complete) {
    fail('incomplete_scope', 'projection admission requires a complete declaration scope');
  }

  const seenIds = new Set();
  const normalizedDeclarations = declarations.map((item, index) => {
    const label = `contractIr.declarations[${index}]`;
    const declaration = requireExactKeys(
      item,
      ['id', 'kind', 'names', 'sources', 'assertionSchema', 'assertionDigest', 'lanes'],
      new Set(['id', 'kind', 'names', 'sources', 'assertionSchema', 'assertionDigest', 'lanes']),
      'invalid_contract_ir',
      label,
    );
    requireBoundedText(declaration.id, 'invalid_contract_ir', `${label}.id`);
    requireString(declaration.kind, 'invalid_contract_ir', `${label}.kind`);
    if (seenIds.has(declaration.id)) fail('duplicate_declaration', `Contract IR repeats declaration ${declaration.id}`);
    seenIds.add(declaration.id);

    const names = requireExactKeys(
      declaration.names,
      ['typespec', 'generatedJsonSchema', 'authoredJsonSchema'],
      new Set(['typespec', 'generatedJsonSchema', 'authoredJsonSchema']),
      'invalid_contract_ir',
      `${label}.names`,
    );
    for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
      requireBoundedText(names[lane], 'invalid_contract_ir', `${label}.names.${lane}`);
    }
    const sources = requireExactKeys(
      declaration.sources,
      ['typespec', 'generatedJsonSchema', 'authoredJsonSchema'],
      new Set(['typespec', 'generatedJsonSchema', 'authoredJsonSchema']),
      'invalid_contract_ir',
      `${label}.sources`,
    );
    for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
      requireSource(sources[lane], `${label}.sources.${lane}`);
    }
    requireHex256(declaration.assertionDigest, 'invalid_contract_ir', `${label}.assertionDigest`);
    if (digestCanonical(declaration.assertionSchema) !== declaration.assertionDigest) {
      fail('assertion_digest_mismatch', `Contract IR declaration ${declaration.id} assertion digest is stale`);
    }
    const lanes = requireExactKeys(
      declaration.lanes,
      ['typespecGeneratedJsonSchema', 'authoredJsonSchema'],
      new Set(['typespecGeneratedJsonSchema', 'authoredJsonSchema']),
      'invalid_contract_ir',
      `${label}.lanes`,
    );
    validateLane(lanes.typespecGeneratedJsonSchema, 'comparison-evidence-only', `${label}.lanes.typespecGeneratedJsonSchema`);
    validateLane(lanes.authoredJsonSchema, 'independently-authored-authority', `${label}.lanes.authoredJsonSchema`);
    return {
      authored: names.authoredJsonSchema,
      generated: names.generatedJsonSchema,
      kind: declaration.kind,
      typespec: names.typespec,
    };
  });
  normalizedDeclarations.sort((left, right) => left.typespec.localeCompare(right.typespec));
  if (canonicalStringifyTsjsvV1(normalizedDeclarations) !== canonicalStringifyTsjsvV1(reportEvidence.normalizedMap)) {
    fail('declaration_map_mismatch', 'Contract IR declarations do not match the report declarationMap');
  }

  excluded.forEach((item, index) => {
    const entry = requireExactKeys(
      item,
      ['authority', 'id', 'kind', 'source'],
      new Set(['authority', 'id', 'kind', 'source']),
      'invalid_contract_ir',
      `contractIr.excludedDeclarations[${index}]`,
    );
    if (!['typespec', 'typespec-generated-json-schema', 'authored-json-schema'].includes(entry.authority)) {
      fail('invalid_contract_ir', `excluded declaration ${index} has invalid authority`);
    }
    requireBoundedText(entry.id, 'invalid_contract_ir', `excluded declaration ${index}.id`);
    requireString(entry.kind, 'invalid_contract_ir', `excluded declaration ${index}.kind`);
    requireSource(entry.source, `contractIr.excludedDeclarations[${index}].source`);
  });
  outOfScope.forEach((item, index) => {
    const entry = requireExactKeys(
      item,
      ['authority', 'id', 'kind', 'reason', 'source'],
      new Set(['authority', 'id', 'kind', 'reason', 'source']),
      'invalid_contract_ir',
      `contractIr.outOfScopeDeclarations[${index}]`,
    );
    if (entry.authority !== 'typespec') fail('invalid_contract_ir', 'out-of-scope authority must be typespec');
    requireBoundedText(entry.id, 'invalid_contract_ir', `out-of-scope declaration ${index}.id`);
    requireString(entry.kind, 'invalid_contract_ir', `out-of-scope declaration ${index}.kind`);
    requireBoundedText(entry.reason, 'invalid_contract_ir', `out-of-scope declaration ${index}.reason`);
    requireSource(entry.source, `contractIr.outOfScopeDeclarations[${index}].source`);
  });

  if (canonicalStringifyTsjsvV1OrNull(value.coverage) !== canonicalStringifyTsjsvV1OrNull(reportEvidence.value.coverage)) {
    fail('coverage_mismatch', 'Contract IR coverage does not match the report');
  }
  if (canonicalStringifyTsjsvV1OrNull(value.toolchain) !== canonicalStringifyTsjsvV1OrNull(reportEvidence.value.toolchain)) {
    fail('toolchain_mismatch', 'Contract IR toolchain does not match the report');
  }
  if (
    canonicalStringifyTsjsvV1OrNull(value.configuration) !==
    canonicalStringifyTsjsvV1OrNull(reportEvidence.value.configuration)
  ) {
    fail('configuration_mismatch', 'Contract IR configuration does not match the report');
  }
  const expectedDifferential = reportEvidence.value.differential?.summary ?? null;
  if (canonicalStringifyTsjsvV1OrNull(value.differential) !== canonicalStringifyTsjsvV1OrNull(expectedDifferential)) {
    fail('differential_mismatch', 'Contract IR differential summary does not match the report');
  }

  const body = { ...value };
  delete body.irId;
  if (digestCanonical(body) !== value.irId) {
    fail('contract_ir_self_digest_mismatch', 'Contract IR irId does not match its exact body');
  }
  return { value, provenanceEvidence };
}
