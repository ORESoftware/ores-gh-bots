import { DEFAULTS } from './constants.mjs';
import { loadContractAdmissionPolicyFile } from './contract-policy.mjs';
import { peerConsultMode } from './peer-consult.mjs';

const REVIEWER_APPROVAL_MODES = new Set(['off', 'requested-gate-success']);
const REVIEWER_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

function optionalString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function integer(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/u.test(text)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  const parsed = Number(text);
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
  const duplicate = entries.find(([context], index) => (
    entries.slice(0, index).some(([previous]) => previous === context)
  ));
  if (duplicate) throw new Error(`Duplicate REQUIRED_CI_APP_IDS context: ${duplicate[0]}`);
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
  const contractAdmissionPolicyPath = optionalString(env.CONTRACT_ADMISSION_POLICY_PATH);
  const contractAdmissionPolicy = loadContractAdmissionPolicyFile(contractAdmissionPolicyPath);

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
  // Attestations are carried by the head-anchored PR review; enabling them
  // without that review would silently publish nothing.
  if (boolean(env.REVIEW_AGENT_ATTESTATIONS, false) && !boolean(env.POST_PULL_REQUEST_REVIEW, false)) {
    throw new Error('REVIEW_AGENT_ATTESTATIONS=true requires POST_PULL_REQUEST_REVIEW=true');
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
      agentAttestations: boolean(env.REVIEW_AGENT_ATTESTATIONS, false),
      peerConsult: peerConsultMode(env.REVIEW_PEER_CONSULT),
    },
    reviewer: {
      login: optionalString(env.REVIEWER_LOGIN) ?? 'the1mills',
      token: optionalString(env.GITHUB_REVIEWER_TOKEN),
      approvalMode: optionalString(env.REVIEWER_APPROVAL_MODE) ?? 'off',
      maxItems: integer(env.REVIEWER_MAX_ITEMS, 100, { min: 1, max: 100 }),
    },
    contractAdmission: {
      policyPath: contractAdmissionPolicyPath,
      policy: contractAdmissionPolicy,
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
    !config.apps.orchestrator.id ? 'GITHUB_APP_ID' : null,
    !config.apps.orchestrator.privateKey ? 'GITHUB_APP_PRIVATE_KEY' : null,
    !config.apps.openai.id ? 'OPENAI_REVIEW_APP_ID' : null,
    !config.apps.openai.privateKey ? 'OPENAI_REVIEW_APP_PRIVATE_KEY' : null,
    !config.apps.claude.id ? 'CLAUDE_REVIEW_APP_ID' : null,
    !config.apps.claude.privateKey ? 'CLAUDE_REVIEW_APP_PRIVATE_KEY' : null,
    !config.apps.gate.id ? 'GATE_APP_ID' : null,
    !config.apps.gate.privateKey ? 'GATE_APP_PRIVATE_KEY' : null,
    webhook && !config.github.webhookSecret ? 'GITHUB_WEBHOOK_SECRET' : null,
    providers && !config.providers.openai.apiKey ? 'OPENAI_API_KEY' : null,
    providers && !config.providers.anthropic.apiKey ? 'ANTHROPIC_API_KEY' : null,
    config.gha.mode === 'offload' && !config.gha.dispatchToken && !config.apps.actions.id
      ? 'ACTIONS_APP_ID'
      : null,
    config.gha.mode === 'offload' && !config.gha.dispatchToken && !config.apps.actions.privateKey
      ? 'ACTIONS_APP_PRIVATE_KEY'
      : null,
    config.reviewer?.approvalMode === 'requested-gate-success' && !config.reviewer?.token
      ? 'GITHUB_REVIEWER_TOKEN'
      : null,
  ].filter(Boolean);
}

function duplicateAppIdentity(config) {
  const identities = [
    ['orchestrator', config.apps.orchestrator.id],
    ['openai', config.apps.openai.id],
    ['claude', config.apps.claude.id],
    ['gate', config.apps.gate.id],
  ].map(([role, id]) => [role, String(id)]);

  return identities
    .flatMap((current, index) => identities.slice(0, index).map((previous) => ({ previous, current })))
    .find(({ previous, current }) => previous[1] === current[1]) ?? null;
}

export function validateRuntimeConfig(config, { webhook = true, providers = true } = {}) {
  const missing = missingRuntimeConfig(config, { webhook, providers });
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);

  if (!config.security?.allowSharedAppIdentity) {
    const duplicate = duplicateAppIdentity(config);
    if (duplicate) {
      const [[previousRole, appId], [currentRole]] = [duplicate.previous, duplicate.current];
      throw new Error(`GitHub App identities must be distinct: ${previousRole} and ${currentRole} both use App ID ${appId}`);
    }
  }

  if (!REVIEWER_APPROVAL_MODES.has(config.reviewer?.approvalMode)) {
    throw new Error(`Unsupported REVIEWER_APPROVAL_MODE: ${config.reviewer?.approvalMode}`);
  }
  const reviewerLogin = String(config.reviewer?.login ?? '');
  if (!REVIEWER_LOGIN_PATTERN.test(reviewerLogin) || reviewerLogin.endsWith('-') || reviewerLogin.includes('--')) {
    throw new Error(`Invalid REVIEWER_LOGIN: ${reviewerLogin}`);
  }

  const unrequiredContext = Object.keys(config.review.requiredCiAppIds ?? {})
    .find((context) => !config.review.requiredCiContexts.includes(context));
  if (unrequiredContext) {
    throw new Error(`REQUIRED_CI_APP_IDS context is not required by REQUIRED_CI_CONTEXTS: ${unrequiredContext}`);
  }
}

export function ownerIsAllowed(config, owner) {
  const normalized = String(owner ?? '').trim();
  if (!normalized) return false;
  if (config.github.ownerAllowlist.length === 0 && config.github.ownerPatterns.length === 0) return false;
  return config.github.ownerAllowlist.some((item) => item.toLowerCase() === normalized.toLowerCase())
    || config.github.ownerPatterns.some((pattern) => pattern.test(normalized));
}
