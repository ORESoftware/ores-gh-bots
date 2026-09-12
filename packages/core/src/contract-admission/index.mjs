import {
  CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
  DEFAULT_MAX_ARTIFACT_BYTES,
} from './constants.mjs';
import {
  AdmissionError,
  digestCanonical,
  fail,
  isObject,
  parseArtifact,
  sha256,
} from './common.mjs';
import { validateManifest } from './manifest.mjs';
import { validateReport } from './report.mjs';
import { validateContractIr } from './contract-ir.mjs';

export * from './constants.mjs';

const locallyVerifiedAdmissions = new WeakSet();
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,127}$/u;

function deepFreeze(value, seen = new WeakSet()) {
  if ((value === null || typeof value !== 'object') || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function markLocallyVerified(result) {
  deepFreeze(result);
  locallyVerifiedAdmissions.add(result);
  return result;
}

function boundedFailureMessage(value) {
  const text = String(value ?? 'contract projection admission failed')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim();
  return (text || 'contract projection admission failed').slice(0, 1_000);
}

/**
 * Return true only for the immutable object graph produced by this module
 * instance. The brand is deliberately held in a module-local WeakSet, so JSON
 * serialization, structured cloning, or object reconstruction cannot preserve
 * it; deep freezing prevents post-verification mutation of the branded graph.
 */
export function isLocallyVerifiedContractProjectionAdmission(value) {
  return isObject(value) && Object.isFrozen(value) && locallyVerifiedAdmissions.has(value);
}

/**
 * Parse a manifest with the same duplicate-key, nesting, UTF-8, and byte bounds
 * used for parity reports and Contract IR. Cross-artifact semantics remain the
 * responsibility of verifyContractProjectionAdmission().
 */
export function parseContractProjectionAdmissionManifestText(
  text,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
) {
  if (
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1024 ||
    maxArtifactBytes > 50 * 1024 * 1024
  ) {
    fail('invalid_expectation', 'maxArtifactBytes is outside the supported range');
  }
  return parseArtifact(text, 'projection admission manifest', maxArtifactBytes);
}

/**
 * Create a bounded immutable failure result for trusted engine failures that
 * happen before a manifest can reach the verifier, such as producer-check
 * identity failures or a missing exact-head artifact.
 */
export function createContractProjectionAdmissionFailure({
  repository,
  headSha,
  projectionKind,
  code,
  message,
  manifestDigest = null,
}) {
  const normalizedCode = typeof code === 'string' && FAILURE_CODE.test(code)
    ? code
    : 'contract_admission_failed';
  return markLocallyVerified({
    schema: CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
    repository: typeof repository === 'string' ? repository : null,
    headSha: typeof headSha === 'string' ? headSha : null,
    projectionKind: typeof projectionKind === 'string' ? projectionKind : null,
    manifestDigest: typeof manifestDigest === 'string' ? manifestDigest : null,
    status: 'failed',
    admissible: false,
    reportRunId: null,
    contractIrId: null,
    findings: [{
      code: normalizedCode,
      message: boundedFailureMessage(message),
    }],
  });
}

function verifyManifestCrossBindings(manifest, reportText, contractIrText, reportEvidence, irEvidence) {
  if (sha256(reportText) !== manifest.producer.reportSha256) {
    fail('report_raw_digest_mismatch', 'manifest report SHA-256 does not match the exact report bytes');
  }
  if (sha256(contractIrText) !== manifest.producer.contractIrSha256) {
    fail('contract_ir_raw_digest_mismatch', 'manifest Contract IR SHA-256 does not match the exact IR bytes');
  }
  for (const lane of ['typespec', 'generatedJsonSchema', 'authoredJsonSchema']) {
    if (manifest.inputs[lane] !== reportEvidence.value.inputs[lane].digest) {
      fail('manifest_input_digest_mismatch', `manifest ${lane} digest does not match the report`);
    }
    if (manifest.inputs[lane] !== irEvidence.provenanceEvidence[lane].value.digest) {
      fail('manifest_input_digest_mismatch', `manifest ${lane} digest does not match the Contract IR`);
    }
  }
}

function resultBase(manifest) {
  return {
    schema: CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
    repository: isObject(manifest) && typeof manifest.repository === 'string' ? manifest.repository : null,
    headSha: isObject(manifest) && typeof manifest.headSha === 'string' ? manifest.headSha : null,
    projectionKind:
      isObject(manifest?.projection) && typeof manifest.projection.kind === 'string'
        ? manifest.projection.kind
        : null,
    manifestDigest: isObject(manifest) ? digestCanonical(manifest) : null,
  };
}

/**
 * Verify exact parity-report, Contract IR, consumer-head, projection, and test
 * evidence before the merge gate treats generated output as admissible.
 */
export function verifyContractProjectionAdmission({
  manifest,
  reportText,
  contractIrText,
  expectedRepository,
  expectedHeadSha,
  allowedProducerCommits,
  requireCompleteScope = true,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
}) {
  const base = resultBase(manifest);
  try {
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1024 || maxArtifactBytes > 50 * 1024 * 1024) {
      fail('invalid_expectation', 'maxArtifactBytes is outside the supported range');
    }
    if (typeof requireCompleteScope !== 'boolean') {
      fail('invalid_expectation', 'requireCompleteScope must be boolean');
    }
    const checkedManifest = validateManifest(
      manifest,
      expectedRepository,
      expectedHeadSha,
      allowedProducerCommits,
    );
    const report = parseArtifact(reportText, 'parity report', maxArtifactBytes);
    const contractIr = parseArtifact(contractIrText, 'Contract IR', maxArtifactBytes);
    const reportEvidence = validateReport(report);
    const irEvidence = validateContractIr(contractIr, reportEvidence, requireCompleteScope);
    verifyManifestCrossBindings(checkedManifest, reportText, contractIrText, reportEvidence, irEvidence);
    return markLocallyVerified({
      ...base,
      status: 'passed',
      admissible: true,
      reportRunId: report.runId,
      contractIrId: contractIr.irId,
      findings: [],
    });
  } catch (error) {
    return markLocallyVerified({
      ...base,
      status: 'failed',
      admissible: false,
      reportRunId: null,
      contractIrId: null,
      findings: [{
        code: error instanceof AdmissionError ? error.code : 'internal_verifier_error',
        message: boundedFailureMessage(error instanceof Error ? error.message : error),
      }],
    });
  }
}
