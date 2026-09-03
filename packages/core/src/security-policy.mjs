function positiveInteger(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateControlPlaneConfig(config, { webhook = true } = {}) {
  const errors = [];
  const requiredRoles = ['orchestrator', 'openai', 'claude', 'gate'];
  const identities = [];

  for (const role of requiredRoles) {
    const id = positiveInteger(config.apps?.[role]?.id);
    if (id === null) errors.push(`${role} GitHub App ID must be a positive integer`);
    else identities.push([role, id]);
  }

  const actionsConfigured = Boolean(config.apps?.actions?.id || config.apps?.actions?.privateKey);
  if (actionsConfigured) {
    const id = positiveInteger(config.apps.actions.id);
    if (id === null) errors.push('actions GitHub App ID must be a positive integer');
    else identities.push(['actions', id]);
    if (!config.apps.actions.privateKey) errors.push('actions GitHub App private key is required when its ID is configured');
  }

  if (!config.security?.allowSharedAppIdentity) {
    const seen = new Map();
    for (const [role, id] of identities) {
      const previous = seen.get(id);
      if (previous) errors.push(`GitHub App identities must be distinct: ${previous} and ${role} both use App ID ${id}`);
      else seen.set(id, role);
    }
  }

  if (!['disabled', 'supplemental', 'offload'].includes(config.gha?.mode)) {
    errors.push('GHA_MODE must be disabled, supplemental, or offload');
  }

  const requiredContexts = config.review?.requiredCiContexts ?? [];
  if (new Set(requiredContexts).size !== requiredContexts.length) {
    errors.push('REQUIRED_CI_CONTEXTS must not contain duplicates');
  }
  for (const context of requiredContexts) {
    if (positiveInteger(config.review?.requiredCiAppIds?.[context]) === null) {
      errors.push(`required CI context must be pinned to a GitHub App ID: ${context}`);
    }
  }

  if (webhook && config.github?.webhookSecret && String(config.github.webhookSecret).length < 20) {
    errors.push('GITHUB_WEBHOOK_SECRET must contain at least 20 characters');
  }

  if (errors.length > 0) {
    throw new Error(`Unsafe control-plane configuration:\n- ${errors.join('\n- ')}`);
  }
}
