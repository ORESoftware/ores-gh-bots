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

/**
 * Return true only for the immutable object graph produced by this module
 * instance. The brand is deliberately held in a module-local WeakSet, so JSON
 * serialization, structured cloning, or object reconstruction cannot preserve
 * it; deep freezing prevents post-verification mutation of the branded graph.
 */
export function isLocallyVerifiedContractProjectionAdmission(value) {
  return isObject(value) && Object.isFrozen(value) && locallyVerifiedAdmissions.has(value);
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
        message: error instanceof Error ? error.message : String(error),
      }],
    });
  }
}
