import { CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA } from './contract-admission.mjs';

export function evaluateGate({
  reviews,
  ci = [],
  requiredCiContexts = [],
  requiredCiAppIds = {},
  projectionAdmissions = [],
  requiredProjectionKinds = [],
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

  const admissionsByKind = new Map();
  for (const admission of Array.isArray(projectionAdmissions) ? projectionAdmissions : []) {
    const kind = admission?.projectionKind;
    if (typeof kind !== 'string' || kind === '') continue;
    const items = admissionsByKind.get(kind) ?? [];
    items.push(admission);
    admissionsByKind.set(kind, items);
  }
  const projectionStates = (Array.isArray(requiredProjectionKinds) ? requiredProjectionKinds : [null]).map((kind) => {
    if (typeof kind !== 'string' || kind === '') {
      return { projectionKind: null, state: 'failure', reason: 'invalid projection requirement' };
    }
    const candidates = admissionsByKind.get(kind) ?? [];
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
      admission.findings.length !== 0
    ) {
      const reason = admission.findings?.[0]?.code ?? admission.status ?? 'invalid admission evidence';
      return { projectionKind: kind, state: 'failure', reason };
    }
    return { projectionKind: kind, state: 'success', reason: 'exact Contract IR evidence admitted' };
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
