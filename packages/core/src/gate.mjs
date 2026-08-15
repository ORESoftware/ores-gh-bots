export function evaluateGate({ reviews, ci = [], requiredCiContexts = [], requiredCiAppIds = {} }) {
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

  const all = [...providerStates, ...ciStates];
  if (all.some((item) => item.state === 'failure')) {
    return { status: 'completed', conclusion: 'failure', providerStates, ciStates };
  }
  if (all.some((item) => item.state === 'pending')) {
    return { status: 'in_progress', conclusion: null, providerStates, ciStates };
  }
  return { status: 'completed', conclusion: 'success', providerStates, ciStates };
}
