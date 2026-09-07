import { REPORT_SCHEMA } from './constants.mjs';
import {
  fail,
  normalizeEvidenceFiles,
  requireArray,
  requireBoundedText,
  requireExactKeys,
  requireHex256,
  requireObject,
  requireString,
} from './common.mjs';

export function validateReport(report) {
  const value = requireObject(report, 'invalid_report', 'report');
  if (value.schema !== REPORT_SCHEMA) fail('invalid_report_schema', `report schema must be ${REPORT_SCHEMA}`);
  requireHex256(value.runId, 'invalid_report', 'report.runId');
  if (value.status !== 'passed') fail('report_not_passed', 'report status must be passed');
  if (value.zeroUnexplainedFindings !== true) {
    fail('report_has_unexplained_findings', 'report must have zero unexplained findings');
  }
  if (!Array.isArray(value.findings) || value.findings.length !== 0) {
    fail('report_findings_not_empty', 'report findings must be an empty array');
  }
  const coverage = requireObject(value.coverage, 'invalid_report', 'report.coverage');
  for (const key of [
    'directDeclarationInventory',
    'typespecGeneratedJsonSchemaComparison',
    'differentialInstanceValidation',
  ]) {
    if (coverage[key] !== true) fail('report_coverage_missing', `report coverage ${key} was not executed`);
  }
  const inputs = requireObject(value.inputs, 'invalid_report', 'report.inputs');
  const normalizedFiles = {};
  for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
    const input = requireObject(inputs[lane], 'invalid_report', `report.inputs.${lane}`);
    requireHex256(input.digest, 'invalid_report', `report.inputs.${lane}.digest`);
    normalizedFiles[lane] = normalizeEvidenceFiles(input.files, `report.inputs.${lane}`);
  }
  const declarationMap = requireArray(value.declarationMap, 'invalid_report', 'report.declarationMap');
  const seen = { typespec: new Set(), generated: new Set(), authored: new Set() };
  const normalizedMap = declarationMap.map((item, index) => {
    const entry = requireExactKeys(
      item,
      ['typespec', 'generated', 'authored', 'kind'],
      new Set(['typespec', 'generated', 'authored', 'kind']),
      'invalid_declaration_map',
      `report.declarationMap[${index}]`,
    );
    for (const lane of ['typespec', 'generated', 'authored']) {
      requireBoundedText(entry[lane], 'invalid_declaration_map', `report.declarationMap[${index}].${lane}`);
      if (seen[lane].has(entry[lane])) {
        fail('duplicate_declaration_map_identity', `report declarationMap repeats ${lane} ${entry[lane]}`);
      }
      seen[lane].add(entry[lane]);
    }
    requireString(entry.kind, 'invalid_declaration_map', `report.declarationMap[${index}].kind`);
    return {
      authored: entry.authored,
      generated: entry.generated,
      kind: entry.kind,
      typespec: entry.typespec,
    };
  });
  normalizedMap.sort((left, right) => left.typespec.localeCompare(right.typespec));
  return { value, normalizedFiles, normalizedMap };
}
