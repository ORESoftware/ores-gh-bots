import { createHash } from 'node:crypto';
import { CHECK_NAMES } from './constants.mjs';

export const CANARY_EVIDENCE_SCHEMA_VERSION = 'ores.review-canary.v1';

const ROLES = Object.freeze(['openai', 'claude', 'gate']);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/iu;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DELIVERY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CHECK_NAME_TO_ROLE = new Map(ROLES.map((role) => [CHECK_NAMES[role], role]));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function digestInput(evidence) {
  if (!isRecord(evidence)) return evidence;
  const { evidence_sha256: _declaredDigest, ...rest } = evidence;
  return rest;
}

export function canonicalCanaryEvidence(evidence) {
  return JSON.stringify(canonicalValue(digestInput(evidence)));
}

export function canaryEvidenceDigest(evidence) {
  return createHash('sha256').update(canonicalCanaryEvidence(evidence)).digest('hex');
}

function push(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function positiveInteger(value, errors, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    push(errors, path, 'must be a positive safe integer');
    return null;
  }
  return value;
}

function sha(value, errors, path) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    push(errors, path, 'must be a 40- or 64-character hexadecimal commit SHA');
    return null;
  }
  return normalized;
}

function timestamp(value, errors, path) {
  const text = String(value ?? '').trim();
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed)) {
    push(errors, path, 'must be an ISO-8601 timestamp');
    return null;
  }
  return { text, milliseconds: parsed };
}

function expectedExternalId(role, repository, pullRequest, headSha) {
  return `${role}:${repository}#${pullRequest}@${headSha}`;
}

function normalizeCheck(check, index, context, errors) {
  const path = `${context.path}.checks[${index}]`;
  if (!isRecord(check)) {
    push(errors, path, 'must be an object');
    return null;
  }

  const name = String(check.name ?? '').trim();
  const role = CHECK_NAME_TO_ROLE.get(name) ?? null;
  if (!role) push(errors, `${path}.name`, `must be one of ${ROLES.map((item) => CHECK_NAMES[item]).join(', ')}`);

  const appId = positiveInteger(check.app_id, errors, `${path}.app_id`);
  const headSha = sha(check.head_sha, errors, `${path}.head_sha`);
  const status = String(check.status ?? '').trim();
  if (!['queued', 'in_progress', 'completed'].includes(status)) {
    push(errors, `${path}.status`, 'must be queued, in_progress, or completed');
  }
  const conclusion = check.conclusion === null || check.conclusion === undefined
    ? null
    : String(check.conclusion).trim();
  if (status === 'completed' && !conclusion) push(errors, `${path}.conclusion`, 'is required for a completed check');
  if (status !== 'completed' && conclusion !== null) push(errors, `${path}.conclusion`, 'must be null until the check is completed');

  const externalId = String(check.external_id ?? '').trim();
  if (!externalId) push(errors, `${path}.external_id`, 'is required');

  if (role && appId !== null && appId !== context.appIds[role]) {
    push(errors, `${path}.app_id`, `does not match the pinned ${role} App ID`);
  }
  if (headSha && headSha !== context.expectedHeadSha) {
    push(errors, `${path}.head_sha`, `must equal snapshot head ${context.expectedHeadSha}`);
  }
  if (role && externalId && externalId !== expectedExternalId(role, context.repository, context.pullRequest, context.expectedHeadSha)) {
    push(errors, `${path}.external_id`, `must bind ${role} to the repository, PR, and exact snapshot SHA`);
  }

  return {
    role,
    name,
    app_id: appId,
    external_id: externalId,
    head_sha: headSha,
    status,
    conclusion,
  };
}

function checkSucceeded(check) {
  return check?.status === 'completed' && check?.conclusion === 'success';
}

function normalizeSnapshot(value, context, errors, mode) {
  if (!isRecord(value)) {
    push(errors, context.path, 'must be an object');
    return null;
  }
  const observed = timestamp(value.observed_at, errors, `${context.path}.observed_at`);
  const headSha = sha(value.head_sha, errors, `${context.path}.head_sha`);
  if (headSha && headSha !== context.expectedHeadSha) {
    push(errors, `${context.path}.head_sha`, `must equal ${context.expectedHeadSha}`);
  }
  if (!Array.isArray(value.checks)) {
    push(errors, `${context.path}.checks`, 'must be an array');
    return { observed, head_sha: headSha, checks: [] };
  }
  if (value.checks.length > 20) push(errors, `${context.path}.checks`, 'must contain no more than 20 check runs');

  const checks = value.checks
    .map((check, index) => normalizeCheck(check, index, context, errors))
    .filter(Boolean);
  const byRole = new Map();
  for (const check of checks) {
    if (!check.role) continue;
    if (byRole.has(check.role)) push(errors, `${context.path}.checks`, `contains more than one latest ${check.role} check`);
    else byRole.set(check.role, check);
  }

  if (mode === 'complete') {
    for (const role of ROLES) {
      const check = byRole.get(role);
      if (!check) push(errors, `${context.path}.checks`, `is missing the ${role} check`);
      else if (!checkSucceeded(check)) push(errors, `${context.path}.checks`, `${role} must be completed successfully`);
    }
  } else if (mode === 'pending') {
    const gate = byRole.get('gate');
    if (checkSucceeded(gate)) {
      push(errors, `${context.path}.checks`, 'must not contain a successful gate for the new head before fresh reviews complete');
    }
    if (ROLES.every((role) => checkSucceeded(byRole.get(role)))) {
      push(errors, `${context.path}.checks`, 'must demonstrate at least one unsatisfied exact-head review or gate');
    }
  }

  return { observed, head_sha: headSha, checks };
}

function normalizeRuleset(value, context, errors) {
  if (!isRecord(value)) {
    push(errors, 'ruleset', 'must be an object');
    return null;
  }
  const name = String(value.name ?? '').trim();
  if (!name) push(errors, 'ruleset.name', 'is required');
  const enforcement = String(value.enforcement ?? '').trim();
  if (!['evaluate', 'active'].includes(enforcement)) {
    push(errors, 'ruleset.enforcement', 'must be evaluate or active');
  }
  const branchMode = String(value.branch_mode ?? '').trim();
  if (!['all', 'protected'].includes(branchMode)) {
    push(errors, 'ruleset.branch_mode', 'must be all or protected');
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    push(errors, 'ruleset.targets', 'must be a non-empty array');
  } else if (value.targets.some((target) => typeof target !== 'string' || !target.startsWith('refs/heads/'))) {
    push(errors, 'ruleset.targets', 'must contain only refs/heads/* patterns');
  }
  if (branchMode === 'all' && !value.targets?.includes('refs/heads/**')) {
    push(errors, 'ruleset.targets', 'must include refs/heads/** when branch_mode is all');
  }

  if (!Array.isArray(value.required_checks)) {
    push(errors, 'ruleset.required_checks', 'must be an array');
    return { name, enforcement, branch_mode: branchMode, targets: value.targets ?? [], required_checks: [] };
  }
  const required = new Map();
  for (const [index, check] of value.required_checks.entries()) {
    const path = `ruleset.required_checks[${index}]`;
    if (!isRecord(check)) {
      push(errors, path, 'must be an object');
      continue;
    }
    const nameValue = String(check.name ?? '').trim();
    const role = CHECK_NAME_TO_ROLE.get(nameValue) ?? null;
    if (!role) push(errors, `${path}.name`, 'must be an ORES review check name');
    const appId = positiveInteger(check.app_id, errors, `${path}.app_id`);
    if (role && appId !== null && appId !== context.appIds[role]) {
      push(errors, `${path}.app_id`, `does not match the pinned ${role} App ID`);
    }
    if (role) {
      if (required.has(role)) push(errors, 'ruleset.required_checks', `contains duplicate ${role} requirements`);
      else required.set(role, { name: nameValue, app_id: appId });
    }
  }
  for (const role of ROLES) {
    if (!required.has(role)) push(errors, 'ruleset.required_checks', `is missing the ${role} requirement`);
  }

  return {
    name,
    enforcement,
    branch_mode: branchMode,
    targets: Array.isArray(value.targets) ? [...value.targets] : [],
    required_checks: [...required.values()],
  };
}

export function verifyCanaryEvidence(evidence, { expectedDigest = null } = {}) {
  const errors = [];
  if (!isRecord(evidence)) {
    return {
      ok: false,
      errors: ['evidence: must be an object'],
      evidence_sha256: null,
      summary: null,
    };
  }

  if (evidence.schema_version !== CANARY_EVIDENCE_SCHEMA_VERSION) {
    push(errors, 'schema_version', `must equal ${CANARY_EVIDENCE_SCHEMA_VERSION}`);
  }
  const repository = String(evidence.repository ?? '').trim();
  if (!REPOSITORY_PATTERN.test(repository)) push(errors, 'repository', 'must use OWNER/REPO syntax');
  const pullRequest = positiveInteger(evidence.pull_request, errors, 'pull_request');

  if (!isRecord(evidence.app_ids)) push(errors, 'app_ids', 'must be an object');
  const appIds = Object.fromEntries(ROLES.map((role) => [
    role,
    positiveInteger(evidence.app_ids?.[role], errors, `app_ids.${role}`),
  ]));
  const nonNullAppIds = ROLES.map((role) => appIds[role]).filter((value) => value !== null);
  if (new Set(nonNullAppIds).size !== nonNullAppIds.length) push(errors, 'app_ids', 'must pin three distinct GitHub App identities');

  const firstHeadSha = sha(evidence.first_head_sha, errors, 'first_head_sha');
  const secondHeadSha = sha(evidence.second_head_sha, errors, 'second_head_sha');
  if (firstHeadSha && secondHeadSha && firstHeadSha === secondHeadSha) {
    push(errors, 'second_head_sha', 'must differ from first_head_sha');
  }

  const readiness = isRecord(evidence.readiness) ? evidence.readiness : null;
  if (!readiness) push(errors, 'readiness', 'must be an object');
  const readinessObserved = timestamp(readiness?.observed_at, errors, 'readiness.observed_at');
  if (readiness?.status !== 200) push(errors, 'readiness.status', 'must equal 200');

  const webhook = isRecord(evidence.webhook) ? evidence.webhook : null;
  if (!webhook) push(errors, 'webhook', 'must be an object');
  if (webhook?.event !== 'pull_request') push(errors, 'webhook.event', 'must equal pull_request');
  if (webhook?.action !== 'synchronize') push(errors, 'webhook.action', 'must equal synchronize');
  if (!DELIVERY_PATTERN.test(String(webhook?.delivery_id ?? ''))) {
    push(errors, 'webhook.delivery_id', 'must be a bounded GitHub delivery identifier');
  }
  const webhookObserved = timestamp(webhook?.observed_at, errors, 'webhook.observed_at');

  const snapshotContext = {
    repository,
    pullRequest,
    appIds,
  };
  const snapshots = isRecord(evidence.snapshots) ? evidence.snapshots : null;
  if (!snapshots) push(errors, 'snapshots', 'must be an object');
  const first = normalizeSnapshot(snapshots?.first_head_complete, {
    ...snapshotContext,
    path: 'snapshots.first_head_complete',
    expectedHeadSha: firstHeadSha,
  }, errors, 'complete');
  const pending = normalizeSnapshot(snapshots?.second_head_pending, {
    ...snapshotContext,
    path: 'snapshots.second_head_pending',
    expectedHeadSha: secondHeadSha,
  }, errors, 'pending');
  const second = normalizeSnapshot(snapshots?.second_head_complete, {
    ...snapshotContext,
    path: 'snapshots.second_head_complete',
    expectedHeadSha: secondHeadSha,
  }, errors, 'complete');

  const chronological = [
    ['snapshots.first_head_complete.observed_at', first?.observed],
    ['webhook.observed_at', webhookObserved],
    ['snapshots.second_head_pending.observed_at', pending?.observed],
    ['snapshots.second_head_complete.observed_at', second?.observed],
  ];
  for (let index = 1; index < chronological.length; index += 1) {
    const [previousPath, previous] = chronological[index - 1];
    const [currentPath, current] = chronological[index];
    if (previous && current && current.milliseconds < previous.milliseconds) {
      push(errors, currentPath, `must not precede ${previousPath}`);
    }
  }
  if (readinessObserved && first?.observed && readinessObserved.milliseconds > first.observed.milliseconds) {
    push(errors, 'readiness.observed_at', 'must be observed before or at the first completed review snapshot');
  }

  const ruleset = normalizeRuleset(evidence.ruleset, { appIds }, errors);
  const digest = canaryEvidenceDigest(evidence);
  const declaredDigest = evidence.evidence_sha256 === undefined
    ? null
    : String(evidence.evidence_sha256).trim().toLowerCase();
  if (declaredDigest !== null && !DIGEST_PATTERN.test(declaredDigest)) {
    push(errors, 'evidence_sha256', 'must be a lowercase SHA-256 digest');
  } else if (declaredDigest !== null && declaredDigest !== digest) {
    push(errors, 'evidence_sha256', 'does not match the canonical evidence digest');
  }
  const expected = expectedDigest === null ? null : String(expectedDigest).trim().toLowerCase();
  if (expected !== null && !DIGEST_PATTERN.test(expected)) {
    push(errors, 'expected_digest', 'must be a SHA-256 digest');
  } else if (expected !== null && expected !== digest) {
    push(errors, 'expected_digest', 'does not match the canonical evidence digest');
  }

  return {
    ok: errors.length === 0,
    errors,
    evidence_sha256: digest,
    summary: {
      schema_version: evidence.schema_version,
      repository,
      pull_request: pullRequest,
      first_head_sha: firstHeadSha,
      second_head_sha: secondHeadSha,
      app_ids: appIds,
      ruleset: ruleset ? {
        name: ruleset.name,
        enforcement: ruleset.enforcement,
        branch_mode: ruleset.branch_mode,
        targets: ruleset.targets,
      } : null,
    },
  };
}

export function assertCanaryEvidence(evidence, options = {}) {
  const result = verifyCanaryEvidence(evidence, options);
  if (!result.ok) {
    const error = new Error(`Canary evidence validation failed:\n${result.errors.map((item) => `- ${item}`).join('\n')}`);
    error.code = 'ORES_CANARY_EVIDENCE_INVALID';
    error.result = result;
    throw error;
  }
  return result;
}
