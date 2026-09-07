import {
  CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
  isLocallyVerifiedContractProjectionAdmission,
} from './contract-admission.mjs';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const HEX_160 = /^[a-f0-9]{40}$/u;
const HEX_256 = /^[a-f0-9]{64}$/u;

function projectionContextError(projectionContext) {
  if (
    projectionContext === null ||
    typeof projectionContext !== 'object' ||
    Array.isArray(projectionContext) ||
    !REPOSITORY.test(projectionContext.repository ?? '') ||
    !HEX_160.test(projectionContext.headSha ?? '')
  ) {
    return 'current projection repository/head context is missing or invalid';
  }
  return null;
}

function evaluateProjectionAdmission(kind, candidates, projectionContext) {
  if (candidates.length === 0) {
    return { projectionKind: kind, state: 'pending', reason: 'admission evidence missing' };
  }
  if (candidates.length !== 1) {
    return { projectionKind: kind, state: 'failure', reason: 'duplicate admission evidence' };
  }
  const admission = candidates[0];
  if (
    admission.schema !== CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA ||
    admission.status !== 'passed' ||
    admission.admissible !== true ||
    !Array.isArray(admission.findings) ||
    admission.findings.length !== 0 ||
    !HEX_256.test(admission.manifestDigest ?? '') ||
    !HEX_256.test(admission.reportRunId ?? '') ||
    !HEX_256.test(admission.contractIrId ?? '')
  ) {
    const reason = admission.findings?.[0]?.code ?? admission.status ?? 'invalid admission evidence';
    return { projectionKind: kind, state: 'failure', reason };
  }

  const contextSupplied = projectionContext !== null && projectionContext !== undefined;
  if (contextSupplied) {
    const contextError = projectionContextError(projectionContext);
    if (contextError) {
      return { projectionKind: kind, state: 'failure', reason: contextError };
    }
    if (admission.repository !== projectionContext.repository) {
      return { projectionKind: kind, state: 'failure', reason: 'admission repository is stale or mismatched' };
    }
    if (admission.headSha !== projectionContext.headSha) {
      return { projectionKind: kind, state: 'failure', reason: 'admission head SHA is stale or mismatched' };
    }
  } else if (!isLocallyVerifiedContractProjectionAdmission(admission)) {
    return {
      projectionKind: kind,
      state: 'failure',
      reason: 'current projection repository/head context is missing or invalid',
    };
  }

  return { projectionKind: kind, state: 'success', reason: 'exact Contract IR evidence admitted' };
}

export function evaluateGate({
  reviews,
  ci = [],
  requiredCiContexts = [],
  requiredCiAppIds = {},
  projectionAdmissions = [],
  requiredProjectionKinds = [],
  projectionContext = null,
}) {
  const providerStates = ['openai', 'claude'].map((provider) => {
    const review = reviews?.[provider] ?? null;
    if (!review) return { provider, state: 'pending', reason: 'review missing' };
    if (review.error) return { provider, state: 'failure', reason: review.error };
    if (review.verdict !== 'approve') return { provider, state: 'failure', reason: `verdict=${review.verdict}` };
    return { provider, state: 'success', reason: 'approved' };
  });

  const latestByContext = new Map();
  for (const item of ci) latestByContext.set(item.context, item);
  const ciStates = requiredCiContexts.map((context) => {
    const item = latestByContext.get(context);
    if (!item) return { context, state: 'pending', reason: 'missing' };
    const expectedAppId = requiredCiAppIds[context] ?? null;
    if (expectedAppId !== null && Number(item.appId) !== Number(expectedAppId)) {
      return {
        context,
        state: 'failure',
        reason: `app identity mismatch: expected ${expectedAppId}, received ${item.appId ?? 'none'}`,
      };
    }
    if (['queued', 'in_progress', 'pending', 'requested', 'waiting', 'expected'].includes(item.state)) {
      return { context, state: 'pending', reason: item.state };
    }
    if (item.state === 'success') return { context, state: 'success', reason: 'success' };
    return { context, state: 'failure', reason: item.state };
  });

  const requiredKinds = Array.isArray(requiredProjectionKinds) ? requiredProjectionKinds : [null];
  const duplicateRequiredKinds = new Set();
  const seenRequiredKinds = new Set();
  for (const kind of requiredKinds) {
    if (seenRequiredKinds.has(kind)) duplicateRequiredKinds.add(kind);
    seenRequiredKinds.add(kind);
  }
  const admissionsByKind = new Map();
  for (const admission of Array.isArray(projectionAdmissions) ? projectionAdmissions : []) {
    const kind = admission?.projectionKind;
    if (typeof kind !== 'string' || kind === '') continue;
    const items = admissionsByKind.get(kind) ?? [];
    items.push(admission);
    admissionsByKind.set(kind, items);
  }
  const projectionStates = requiredKinds.map((kind) => {
    if (typeof kind !== 'string' || kind === '') {
      return { projectionKind: null, state: 'failure', reason: 'invalid projection requirement' };
    }
    if (duplicateRequiredKinds.has(kind)) {
      return { projectionKind: kind, state: 'failure', reason: 'duplicate projection requirement' };
    }
    return evaluateProjectionAdmission(kind, admissionsByKind.get(kind) ?? [], projectionContext);
  });

  const all = [...providerStates, ...ciStates, ...projectionStates];
  if (all.some((item) => item.state === 'failure')) {
    return { status: 'completed', conclusion: 'failure', providerStates, ciStates, projectionStates };
  }
  if (all.some((item) => item.state === 'pending')) {
    return { status: 'in_progress', conclusion: null, providerStates, ciStates, projectionStates };
  }
  return { status: 'completed', conclusion: 'success', providerStates, ciStates, projectionStates };
}
