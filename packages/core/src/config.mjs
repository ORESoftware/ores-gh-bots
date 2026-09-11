import { DEFAULTS } from './constants.mjs';

function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredCiAppIdEntry(item) {
  const separator = item.lastIndexOf('=');
  if (separator <= 0 || separator === item.length - 1) {
    throw new Error(`Invalid REQUIRED_CI_APP_IDS entry: ${item}`);
  }
  const context = item.slice(0, separator).trim();
  const appId = integer(item.slice(separator + 1), null, { min: 1 });
  if (!context || appId === null) throw new Error(`Invalid REQUIRED_CI_APP_IDS entry: ${item}`);
  return [context, appId];
}

function requiredCiAppIds(value) {
  const entries = csv(value).map(requiredCiAppIdEntry);
  const duplicate = entries.find(
    ([context], index) => entries.findIndex(([candidate]) => candidate === context) !== index,
  );
  if (duplicate) {
    throw new Error(`Duplicate REQUIRED_CI_APP_IDS context: ${duplicate[0]}`);
  }
  return Object.fromEntries(entries);
}

function normalizePrivateKey(value) {
  const text = optionalString(value);
  if (!text) return null;
  if (text.startsWith('base64:')) {
    return Buffer.from(text.slice('base64:'.length), 'base64').toString('utf8');
  }
  return text.replace(/\\n/g, '\n');
}

function appCredentials(env, prefix, fallback = null) {
  const id = optionalString(env[`${prefix}_APP_ID`]) ?? fallback?.id ?? null;
  const privateKey = normalizePrivateKey(env[`${prefix}_APP_PRIVATE_KEY`]) ?? fallback?.privateKey ?? null;
  return { id, privateKey };
}

export function loadConfig(env = process.env) {
  const orchestrator = {
    id: optionalString(env.GITHUB_APP_ID),
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
  };
  const allowSharedAppIdentity = boolean(env.ALLOW_SHARED_APP_IDENTITY, false);
  const reviewerFallback = allowSharedAppIdentity ? orchestrator : null;

  const ownerAllowlist = csv(env.OWNER_ALLOWLIST);
  const ownerPatterns = csv(env.OWNER_PATTERNS).map((pattern) => new RegExp(pattern, 'i'));

  return {
    server: {
      port: integer(env.PORT, DEFAULTS.port, { min: 1, max: 65535 }),
      webhookPath: optionalString(env.GITHUB_WEBHOOK_PATH) ?? '/webhooks/github',
      bodyLimitBytes: integer(env.BODY_LIMIT_BYTES, DEFAULTS.bodyLimitBytes, { min: 1_024 }),
    },
    github: {
      apiBaseUrl: optionalString(env.GITHUB_API_BASE_URL) ?? DEFAULTS.githubApiBaseUrl,
      apiVersion: optionalString(env.GITHUB_API_VERSION) ?? DEFAULTS.githubApiVersion,
      webhookSecret: optionalString(env.GITHUB_WEBHOOK_SECRET),
      ownerAllowlist,
      ownerPatterns,
      detailsBaseUrl: optionalString(env.DETAILS_BASE_URL),
    },
    apps: {
      orchestrator,
      openai: appCredentials(env, 'OPENAI_REVIEW', reviewerFallback),
      claude: appCredentials(env, 'CLAUDE_REVIEW', reviewerFallback),
      gate: appCredentials(env, 'GATE', reviewerFallback),
      actions: appCredentials(env, 'ACTIONS'),
    },
    security: {
      allowSharedAppIdentity,
    },
    providers: {
      openai: {
        apiKey: optionalString(env.OPENAI_API_KEY),
        baseUrl: optionalString(env.OPENAI_BASE_URL) ?? 'https://api.openai.com',
        model: optionalString(env.OPENAI_MODEL) ?? 'gpt-5-mini',
        maxOutputTokens: integer(env.OPENAI_MAX_OUTPUT_TOKENS, 8_000, { min: 256 }),
      },
      anthropic: {
        apiKey: optionalString(env.ANTHROPIC_API_KEY),
        baseUrl: optionalString(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com',
        model: optionalString(env.ANTHROPIC_MODEL) ?? 'claude-sonnet-4-5',
        maxTokens: integer(env.ANTHROPIC_MAX_TOKENS, 8_000, { min: 256 }),
        version: optionalString(env.ANTHROPIC_VERSION) ?? '2023-06-01',
      },
    },
    review: {
      maxDiffBytes: integer(env.MAX_DIFF_BYTES, DEFAULTS.maxDiffBytes, { min: 10_000 }),
      maxFileBytes: integer(env.MAX_FILE_BYTES, DEFAULTS.maxFileBytes, { min: 1_000 }),
      maxFiles: integer(env.MAX_FILES, DEFAULTS.maxFiles, { min: 1 }),
      maxFindings: integer(env.MAX_FINDINGS, DEFAULTS.maxFindings, { min: 1, max: 50 }),
      timeoutMs: integer(env.REVIEW_TIMEOUT_MS, DEFAULTS.reviewTimeoutMs, { min: 5_000 }),
      requiredCiContexts: csv(env.REQUIRED_CI_CONTEXTS),
      requiredCiAppIds: requiredCiAppIds(env.REQUIRED_CI_APP_IDS),
      commentMode: optionalString(env.REVIEW_COMMENT_MODE) ?? 'summary',
      postPullRequestReview: boolean(env.POST_PULL_REQUEST_REVIEW, false),
    },
    queue: {
      path: optionalString(env.QUEUE_PATH) ?? DEFAULTS.queuePath,
      pollMs: integer(env.QUEUE_POLL_MS, DEFAULTS.queuePollMs, { min: 50 }),
      leaseMs: integer(env.QUEUE_LEASE_MS, DEFAULTS.queueLeaseMs, { min: 10_000 }),
      maxAttempts: integer(env.QUEUE_MAX_ATTEMPTS, DEFAULTS.queueMaxAttempts, { min: 1 }),
      workerConcurrency: integer(env.WORKER_CONCURRENCY, DEFAULTS.workerConcurrency, { min: 1, max: 32 }),
    },
    reconciliation: {
      enabled: boolean(env.RECONCILE_ENABLED, true),
      intervalMs: integer(env.RECONCILE_INTERVAL_MS, DEFAULTS.reconcileIntervalMs, { min: 60_000 }),
      maxRepos: integer(env.RECONCILE_MAX_REPOS, DEFAULTS.reconcileMaxRepos, { min: 1 }),
      maxPrsPerRepo: integer(env.RECONCILE_MAX_PRS_PER_REPO, DEFAULTS.reconcileMaxPrsPerRepo, { min: 1, max: 100 }),
    },
    gha: {
      mode: optionalString(env.GHA_MODE) ?? 'supplemental',
      dispatchToken: optionalString(env.GHA_DISPATCH_TOKEN),
      installationId: integer(env.GHA_INSTALLATION_ID, 0, { min: 0 }),
      repository: optionalString(env.GHA_REPOSITORY) ?? 'ORESoftware/ores-gh-bots',
      workflowId: optionalString(env.GHA_WORKFLOW_ID) ?? 'review-dispatch.yml',
      ref: optionalString(env.GHA_REF) ?? 'main',
    },
    admin: {
      token: optionalString(env.GITHUB_ADMIN_TOKEN),
      fleetConfigPath: optionalString(env.FLEET_CONFIG_PATH) ?? 'config/fleet.example.json',
    },
  };
}

function missingRuntimeConfig(config, { webhook, providers }) {
  return [
    [!config.apps.orchestrator.id, 'GITHUB_APP_ID'],
    [!config.apps.orchestrator.privateKey, 'GITHUB_APP_PRIVATE_KEY'],
    [!config.apps.openai.id, 'OPENAI_REVIEW_APP_ID'],
    [!config.apps.openai.privateKey, 'OPENAI_REVIEW_APP_PRIVATE_KEY'],
    [!config.apps.claude.id, 'CLAUDE_REVIEW_APP_ID'],
    [!config.apps.claude.privateKey, 'CLAUDE_REVIEW_APP_PRIVATE_KEY'],
    [!config.apps.gate.id, 'GATE_APP_ID'],
    [!config.apps.gate.privateKey, 'GATE_APP_PRIVATE_KEY'],
    [webhook && !config.github.webhookSecret, 'GITHUB_WEBHOOK_SECRET'],
    [providers && !config.providers.openai.apiKey, 'OPENAI_API_KEY'],
    [providers && !config.providers.anthropic.apiKey, 'ANTHROPIC_API_KEY'],
    [config.gha.mode === 'offload' && !config.gha.dispatchToken && !config.apps.actions.id, 'ACTIONS_APP_ID'],
    [config.gha.mode === 'offload' && !config.gha.dispatchToken && !config.apps.actions.privateKey, 'ACTIONS_APP_PRIVATE_KEY'],
  ]
    .filter(([missing]) => missing)
    .map(([, key]) => key);
}

function sharedIdentityError(config) {
  if (config.security?.allowSharedAppIdentity) return null;

  const identities = [
    ['orchestrator', config.apps.orchestrator.id],
    ['openai', config.apps.openai.id],
    ['claude', config.apps.claude.id],
    ['gate', config.apps.gate.id],
  ].map(([role, id]) => [role, String(id)]);

  const duplicate = identities.find(
    ([, id], index) => identities.slice(0, index).some(([, previousId]) => previousId === id),
  );
  if (!duplicate) return null;

  const [role, id] = duplicate;
  const [previous] = identities.find(([, candidate]) => candidate === id);
  return `GitHub App identities must be distinct: ${previous} and ${role} both use App ID ${id}`;
}

/// Return the first runtime configuration violation as a value.
///
/// This is the pure validation core. It does not mutate `config`, accumulate
/// caller-owned state, or throw. `validateRuntimeConfig` remains the imperative
/// startup shell for existing call sites that expect exceptions.
export function runtimeConfigError(config, { webhook = true, providers = true } = {}) {
  const missing = missingRuntimeConfig(config, { webhook, providers });
  if (missing.length) return `Missing required configuration: ${missing.join(', ')}`;

  const identityError = sharedIdentityError(config);
  if (identityError) return identityError;

  const unexpectedContext = Object.keys(config.review.requiredCiAppIds ?? {})
    .find((context) => !config.review.requiredCiContexts.includes(context));
  return unexpectedContext
    ? `REQUIRED_CI_APP_IDS context is not required by REQUIRED_CI_CONTEXTS: ${unexpectedContext}`
    : null;
}

export function validateRuntimeConfig(config, options = {}) {
  const error = runtimeConfigError(config, options);
  if (error) throw new Error(error);
}

export function ownerIsAllowed(config, owner) {
  const normalized = String(owner ?? '').trim();
  if (!normalized) return false;
  if (config.github.ownerAllowlist.length === 0 && config.github.ownerPatterns.length === 0) return false;
  return config.github.ownerAllowlist.some((item) => item.toLowerCase() === normalized.toLowerCase())
    || config.github.ownerPatterns.some((pattern) => pattern.test(normalized));
}
