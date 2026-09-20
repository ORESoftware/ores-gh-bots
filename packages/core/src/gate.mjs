import {
  CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA,
  isLocallyVerifiedContractProjectionAdmission,
} from './contract-admission.mjs';
import { normalizeDependencyGateStates } from './pr-dependencies.mjs';

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

function evaluateNormalizedCiContext(context, item) {
  if (['queued', 'in_progress', 'pending', 'requested', 'waiting', 'expected'].includes(item.state)) {
    return { context, state: 'pending', reason: item.state };
  }
  if (item.state === 'success') return { context, state: 'success', reason: 'success' };
  return { context, state: 'failure', reason: item.state };
}

function evaluateRequiredCiContext(context, item, expectedAppId) {
  if (!item) return { context, state: 'pending', reason: 'missing' };

  if (expectedAppId !== null) {
    if (Number(item.appId) !== Number(expectedAppId)) {
      return {
        context,
        state: 'failure',
        reason: `app identity mismatch: expected ${expectedAppId}, received ${item.appId ?? 'none'}`,
      };
    }

    const hasTransportProvenance = (
      item.source !== undefined || item.rawStatus !== undefined || item.rawConclusion !== undefined
    );

    // Runtime GitHub snapshots are authenticated evidence families, not generic
    // branch-protection contexts. Once transport provenance is present, require
    // a real Check Run from the expected App with GitHub's raw terminal
    // `completed/success` state. This prevents neutral/skipped normalization or
    // a same-name PAT status from satisfying an App-bound context.
    //
    // `evaluateGate` is also a pure function used by older unit fixtures that
    // inject already-normalized CI objects directly. Those provenance-less
    // synthetic objects retain normalized semantics; the production path always
    // enters here through getCiSnapshot(), which supplies source/raw fields.
    if (!hasTransportProvenance) return evaluateNormalizedCiContext(context, item);
    if (item.source !== 'check_run') {
      return { context, state: 'failure', reason: 'App-bound CI requires a GitHub Check Run' };
    }
    if (item.rawStatus !== 'completed') {
      if (['queued', 'in_progress', 'pending', 'requested', 'waiting', 'expected'].includes(item.rawStatus)) {
        return { context, state: 'pending', reason: item.rawStatus };
      }
      return {
        context,
        state: 'failure',
        reason: `invalid raw check status: ${item.rawStatus ?? 'missing'}`,
      };
    }
    if (item.rawConclusion !== 'success') {
      return {
        context,
        state: 'failure',
        reason: `raw check conclusion is ${item.rawConclusion ?? 'missing'}, not success`,
      };
    }
    return { context, state: 'success', reason: 'App-owned completed/success Check Run' };
  }

  return evaluateNormalizedCiContext(context, item);
}

export function evaluateGate({
  reviews,
  ci = [],
  requiredCiContexts = [],
  requiredCiAppIds = {},
  projectionAdmissions = [],
  requiredProjectionKinds = [],
  projectionContext = null,
  dependencyStates = [],
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
  const ciStates = requiredCiContexts.map((context) => evaluateRequiredCiContext(
    context,
    latestByContext.get(context),
    requiredCiAppIds[context] ?? null,
  ));

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

  const normalizedDependencyStates = normalizeDependencyGateStates(dependencyStates);
  const all = [...providerStates, ...ciStates, ...projectionStates, ...normalizedDependencyStates];
  const result = {
    providerStates,
    ciStates,
    projectionStates,
    dependencyStates: normalizedDependencyStates,
  };
  if (all.some((item) => item.state === 'failure')) {
    return { status: 'completed', conclusion: 'failure', ...result };
  }
  if (all.some((item) => item.state === 'pending')) {
    return { status: 'in_progress', conclusion: null, ...result };
  }
  return { status: 'completed', conclusion: 'success', ...result };
}
