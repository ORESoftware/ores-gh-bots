import { DEFAULTS } from './constants.mjs';

const DEFAULT_PROVIDER_ALLOWED_ORIGINS = [
  'https://api.openai.com',
  'https://api.anthropic.com',
];

function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/u.test(text)) {
    throw new Error('Invalid integer configuration value');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('Invalid integer configuration value');
  }
  return parsed;
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('Invalid boolean configuration value');
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function providerAllowedOrigins(value) {
  const configured = csv(value);
  const values = configured.length ? configured : DEFAULT_PROVIDER_ALLOWED_ORIGINS;
  const origins = [];
  for (const [index, item] of values.entries()) {
    let parsed;
    try {
      parsed = new URL(item);
    } catch {
      throw new Error(`PROVIDER_ALLOWED_ORIGINS entry ${index + 1} is invalid`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error(`PROVIDER_ALLOWED_ORIGINS entry ${index + 1} must be a credential-free HTTPS origin`);
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return origins;
}

function requiredCiAppIds(value) {
  const result = {};
  for (const [index, item] of csv(value).entries()) {
    const separator = item.lastIndexOf('=');
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error(`REQUIRED_CI_APP_IDS entry ${index + 1} is invalid`);
    }
    const context = item.slice(0, separator).trim();
    const appId = integer(item.slice(separator + 1), null, { min: 1 });
    if (!context || appId === null) throw new Error(`REQUIRED_CI_APP_IDS entry ${index + 1} is invalid`);
    if (Object.hasOwn(result, context)) throw new Error(`REQUIRED_CI_APP_IDS entry ${index + 1} duplicates a context`);
    result[context] = appId;
  }
  return result;
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

function validateProviderBaseUrl(name, value, allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} base URL is invalid`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${name} base URL must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${name} base URL must not contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${name} base URL must not contain a query string or fragment`);
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`${name} base URL origin is not allowed: ${parsed.origin}`);
  }
}

export function loadConfig(env = process.env) {
  const orchestrator = {
    id: optionalString(env.GITHUB_APP_ID),
    privateKey: normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
  };
  const allowSharedAppIdentity = boolean(env.ALLOW_SHARED_APP_IDENTITY, false);
  const reviewerFallback = allowSharedAppIdentity ? orchestrator : null;

  const ownerAllowlist = csv(env.OWNER_ALLOWLIST);
  const ownerPatterns = csv(env.OWNER_PATTERNS).map((pattern, index) => {
    try { return new RegExp(pattern, 'i'); }
    catch { throw new Error(`OWNER_PATTERNS entry ${index + 1} is invalid`); }
  });

  const server = {
    port: integer(env.PORT, DEFAULTS.port, { min: 1, max: 65_535 }),
    webhookPath: optionalString(env.GITHUB_WEBHOOK_PATH) ?? '/webhooks/github',
    bodyLimitBytes: integer(env.BODY_LIMIT_BYTES, DEFAULTS.bodyLimitBytes, { min: 1_024, max: 16_777_216 }),
    headersTimeoutMs: integer(env.HTTP_HEADERS_TIMEOUT_MS, DEFAULTS.headersTimeoutMs, { min: 1_000, max: 120_000 }),
    requestTimeoutMs: integer(env.HTTP_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, { min: 1_000, max: 300_000 }),
    keepAliveTimeoutMs: integer(env.HTTP_KEEP_ALIVE_TIMEOUT_MS, DEFAULTS.keepAliveTimeoutMs, { min: 1_000, max: 60_000 }),
    maxHeaderBytes: integer(env.HTTP_MAX_HEADER_BYTES, DEFAULTS.maxHeaderBytes, { min: 8_192, max: 65_536 }),
    maxHeadersCount: integer(env.HTTP_MAX_HEADERS_COUNT, DEFAULTS.maxHeadersCount, { min: 16, max: 256 }),
    maxRequestsPerSocket: integer(env.HTTP_MAX_REQUESTS_PER_SOCKET, DEFAULTS.maxRequestsPerSocket, { min: 1, max: 10_000 }),
  };
  if (server.headersTimeoutMs > server.requestTimeoutMs) {
    throw new Error('HTTP_HEADERS_TIMEOUT_MS must not exceed HTTP_REQUEST_TIMEOUT_MS');
  }

  return {
    server,
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
      reaper: appCredentials(env, 'MERGE_REAPER'),
    },
    security: {
      allowSharedAppIdentity,
      providerAllowedOrigins: providerAllowedOrigins(env.PROVIDER_ALLOWED_ORIGINS),
    },
    providers: {
      openai: {
        apiKey: optionalString(env.OPENAI_API_KEY),
        baseUrl: optionalString(env.OPENAI_BASE_URL) ?? 'https://api.openai.com',
        model: optionalString(env.OPENAI_MODEL) ?? 'gpt-5.6-sol',
        maxOutputTokens: integer(env.OPENAI_MAX_OUTPUT_TOKENS, 16_000, { min: 256 }),
      },
      anthropic: {
        apiKey: optionalString(env.ANTHROPIC_API_KEY),
        baseUrl: optionalString(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com',
        model: optionalString(env.ANTHROPIC_MODEL) ?? 'claude-sonnet-5',
        maxTokens: integer(env.ANTHROPIC_MAX_TOKENS, 16_000, { min: 256 }),
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

export function validateRuntimeConfig(config, { webhook = true, providers = true } = {}) {
  const missing = [];
  if (!config.apps.orchestrator.id) missing.push('GITHUB_APP_ID');
  if (!config.apps.orchestrator.privateKey) missing.push('GITHUB_APP_PRIVATE_KEY');
  if (!config.apps.openai.id) missing.push('OPENAI_REVIEW_APP_ID');
  if (!config.apps.openai.privateKey) missing.push('OPENAI_REVIEW_APP_PRIVATE_KEY');
  if (!config.apps.claude.id) missing.push('CLAUDE_REVIEW_APP_ID');
  if (!config.apps.claude.privateKey) missing.push('CLAUDE_REVIEW_APP_PRIVATE_KEY');
  if (!config.apps.gate.id) missing.push('GATE_APP_ID');
  if (!config.apps.gate.privateKey) missing.push('GATE_APP_PRIVATE_KEY');
  if (webhook && !config.github.webhookSecret) missing.push('GITHUB_WEBHOOK_SECRET');
  if (providers && !config.providers.openai.apiKey) missing.push('OPENAI_API_KEY');
  if (providers && !config.providers.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (config.gha.mode === 'offload' && !config.gha.dispatchToken) {
    if (!config.apps.actions.id) missing.push('ACTIONS_APP_ID');
    if (!config.apps.actions.privateKey) missing.push('ACTIONS_APP_PRIVATE_KEY');
  }
  const reaperConfigured = Boolean(config.apps.reaper.id || config.apps.reaper.privateKey);
  if (reaperConfigured) {
    if (!config.apps.reaper.id) missing.push('MERGE_REAPER_APP_ID');
    if (!config.apps.reaper.privateKey) missing.push('MERGE_REAPER_APP_PRIVATE_KEY');
  }
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);

  if (providers) {
    const allowedOrigins = config.security?.providerAllowedOrigins ?? DEFAULT_PROVIDER_ALLOWED_ORIGINS;
    validateProviderBaseUrl('OpenAI', config.providers.openai.baseUrl, allowedOrigins);
    validateProviderBaseUrl('Anthropic', config.providers.anthropic.baseUrl, allowedOrigins);
  }

  if (!config.security?.allowSharedAppIdentity) {
    const identities = [
      ['orchestrator', config.apps.orchestrator.id],
      ['openai', config.apps.openai.id],
      ['claude', config.apps.claude.id],
      ['gate', config.apps.gate.id],
      ...(config.apps.actions.id ? [['actions', config.apps.actions.id]] : []),
      ...(config.apps.reaper.id ? [['reaper', config.apps.reaper.id]] : []),
    ];
    const seen = new Map();
    for (const [role, id] of identities) {
      const normalized = String(id);
      const previous = seen.get(normalized);
      if (previous) {
        throw new Error(`GitHub App identities must be distinct: ${previous} and ${role} both use App ID ${normalized}`);
      }
      seen.set(normalized, role);
    }
  }

  for (const context of Object.keys(config.review.requiredCiAppIds ?? {})) {
    if (!config.review.requiredCiContexts.includes(context)) {
      throw new Error(`REQUIRED_CI_APP_IDS context is not required by REQUIRED_CI_CONTEXTS: ${context}`);
    }
  }
}

export function ownerIsAllowed(config, owner) {
  const normalized = String(owner ?? '').trim();
  if (!normalized) return false;
  if (config.github.ownerAllowlist.length === 0 && config.github.ownerPatterns.length === 0) return false;
  return config.github.ownerAllowlist.some((item) => item.toLowerCase() === normalized.toLowerCase())
    || config.github.ownerPatterns.some((pattern) => pattern.test(normalized));
}
