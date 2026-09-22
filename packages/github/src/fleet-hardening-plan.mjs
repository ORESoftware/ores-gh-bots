import { createHash } from 'node:crypto';
import { GitHubHttpError } from './client.mjs';
import {
  getRepository,
  getRepositoryTextFile,
  listOrganizationRepositories,
  organizationPolicyDocument,
  repositoryPolicyDocument,
  upsertRepositoryTextFile,
  validateHardeningFleet,
} from './hardening.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,240}$/u;
const MAX_PLAN_OPERATIONS = 1000;
const DEFAULT_MAX_REPOSITORIES = 500;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

export function canonicalFleetHardeningJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fleetHardeningDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalFleetHardeningJson(value)).digest('hex')}`;
}

function contentDigest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function canonicalText(value) {
  return `${String(value).replace(/\r\n/gu, '\n').replace(/\s+$/u, '')}\n`;
}

function globPattern(value) {
  const escaped = String(value)
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.');
  return new RegExp(`^${escaped}$`, 'iu');
}

export function repositoryInHardeningScope(scope, repository) {
  if (!repository || typeof repository !== 'object') return false;
  if (scope?.skip_archived !== false && repository.archived) return false;
  if (scope?.skip_disabled !== false && repository.disabled) return false;
  if (scope?.skip_forks !== false && repository.fork) return false;

  const include = Array.isArray(scope?.include) && scope.include.length > 0 ? scope.include : ['*'];
  if (!include.some((pattern) => globPattern(pattern).test(repository.name))) return false;

  const excluded = Array.isArray(scope?.exclude_name_patterns) ? scope.exclude_name_patterns : [];
  for (const source of excluded) {
    let pattern;
    try {
      pattern = new RegExp(source, 'u');
    } catch {
      throw new Error(`Invalid repository exclusion regex: ${source}`);
    }
    if (pattern.test(repository.name)) return false;
  }
  return true;
}

function requireSingleOrganization(fleet, organizationName, expectedEnvironment) {
  const requested = String(organizationName ?? '').trim();
  if (!requested) throw new Error('Fleet hardening requires one explicit --organization; blank means fail closed');
  const matches = fleet.organizations.filter((organization) => organization.name.toLowerCase() === requested.toLowerCase());
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous organization: ${requested}`);
  const organization = matches[0];
  if (!['test', 'production'].includes(organization.environment)) {
    throw new Error(`Organization ${organization.name} has no explicit test/production environment`);
  }
  if (expectedEnvironment && organization.environment !== expectedEnvironment) {
    throw new Error(`Organization ${organization.name} is ${organization.environment}, not ${expectedEnvironment}`);
  }
  return organization;
}

async function getBranchHead(client, token, owner, repo, branch) {
  try {
    const response = await client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      { token },
    );
    const sha = response.data?.object?.sha;
    if (!SHA.test(String(sha ?? ''))) throw new Error(`${owner}/${repo}:${branch} returned an invalid ref SHA`);
    return sha;
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null;
    throw error;
  }
}

async function planFileOperation(client, token, { owner, repo, branch, path, content }) {
  const normalized = canonicalText(content);
  const existing = await getRepositoryTextFile(client, token, { owner, repo, path, ref: branch });
  if (existing && canonicalText(existing.content) === normalized) return null;
  return {
    repository: `${owner}/${repo}`,
    default_branch: branch,
    expected_head_sha: await getBranchHead(client, token, owner, repo, branch),
    path,
    content: normalized,
    content_sha256: contentDigest(normalized),
    previous_blob_sha: existing?.sha ?? null,
  };
}

function normalizeOperation(operation) {
  if (!isRecord(operation)) throw new Error('Plan operation must be an object');
  const repository = String(operation.repository ?? '');
  const [owner, repo, ...extra] = repository.split('/');
  if (!owner || !repo || extra.length) throw new Error(`Invalid plan repository: ${repository}`);
  const defaultBranch = String(operation.default_branch ?? '');
  const expectedHead = String(operation.expected_head_sha ?? '');
  const path = String(operation.path ?? '');
  const content = String(operation.content ?? '');
  const declaredDigest = String(operation.content_sha256 ?? '');
  if (!defaultBranch || !SAFE_BRANCH.test(defaultBranch)) throw new Error(`Invalid default branch for ${repository}`);
  if (!SHA.test(expectedHead)) throw new Error(`Invalid expected head for ${repository}`);
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => ['', '.', '..'].includes(part))) {
    throw new Error(`Invalid plan path for ${repository}`);
  }
  const actualDigest = contentDigest(content);
  if (declaredDigest !== actualDigest) throw new Error(`Content digest mismatch for ${repository}:${path}`);
  return {
    repository,
    owner,
    repo,
    defaultBranch,
    expectedHead,
    path,
    content,
    contentDigest: actualDigest,
    previousBlobSha: operation.previous_blob_sha ?? null,
  };
}

export async function buildFleetHardeningPlan(client, token, fleetInput, {
  organizationName,
  expectedEnvironment,
  includeRepositories = false,
  maxRepositories = DEFAULT_MAX_REPOSITORIES,
  sourceRevision,
  implementationDigest,
} = {}) {
  const fleet = validateHardeningFleet(fleetInput);
  if (!SHA.test(String(sourceRevision ?? ''))) throw new Error('Planning requires a 40-hex source revision');
  if (!SHA256.test(String(implementationDigest ?? ''))) throw new Error('Planning requires an implementation sha256 digest');
  if (!Number.isSafeInteger(maxRepositories) || maxRepositories < 1 || maxRepositories > MAX_PLAN_OPERATIONS) {
    throw new Error(`maxRepositories must be an integer between 1 and ${MAX_PLAN_OPERATIONS}`);
  }
  const organization = requireSingleOrganization(fleet, organizationName, expectedEnvironment);
  const policyRepositoryName = organization.policy_repository ?? fleet.defaults.policy_repository ?? '.github';
  const policyRepository = await getRepository(client, token, organization.name, policyRepositoryName);
  if (!policyRepository || policyRepository.archived || policyRepository.disabled || policyRepository.fork) {
    throw new Error(`${organization.name}/${policyRepositoryName} must already exist as a live non-fork policy repository`);
  }

  const operations = [];
  const policyOperation = await planFileOperation(client, token, {
    owner: organization.name,
    repo: policyRepositoryName,
    branch: policyRepository.default_branch,
    path: organization.policy_path ?? fleet.defaults.policy_path ?? 'policy/ores-fleet-hardening.v1.json',
    content: JSON.stringify(organizationPolicyDocument(fleet, organization), null, 2),
  });
  if (policyOperation) operations.push(policyOperation);

  if (includeRepositories) {
    const scope = organization.repository_scope ?? fleet.defaults.repository_scope ?? {};
    const repositories = await listOrganizationRepositories(client, token, organization.name, maxRepositories);
    for (const repository of repositories) {
      if (repository.name === policyRepositoryName || !repositoryInHardeningScope(scope, repository)) continue;
      const operation = await planFileOperation(client, token, {
        owner: organization.name,
        repo: repository.name,
        branch: repository.default_branch,
        path: fleet.defaults.repository_policy_path ?? '.ores/repository-hardening.v1.json',
        content: JSON.stringify(repositoryPolicyDocument(fleet, organization, repository), null, 2),
      });
      if (operation) operations.push(operation);
      if (operations.length > MAX_PLAN_OPERATIONS) throw new Error(`Plan exceeds ${MAX_PLAN_OPERATIONS} operations`);
    }
  }

  operations.sort((left, right) => (
    left.repository.localeCompare(right.repository) || left.path.localeCompare(right.path)
  ));
  return {
    schema: 'ores.fleet-hardening-plan.v1',
    source_revision: sourceRevision,
    implementation_sha256: implementationDigest,
    config_sha256: fleetHardeningDigest(fleet),
    organization: organization.name,
    environment: organization.environment,
    include_repositories: Boolean(includeRepositories),
    operation_count: operations.length,
    operations,
  };
}

export function fleetHardeningPlanDigest(plan) {
  return fleetHardeningDigest(plan);
}

export function validateFleetHardeningPlan(plan, {
  expectedDigest,
  fleet,
  implementationDigest,
  expectedEnvironment,
} = {}) {
  if (!isRecord(plan) || plan.schema !== 'ores.fleet-hardening-plan.v1') throw new Error('Unsupported fleet hardening plan');
  if (!SHA256.test(String(expectedDigest ?? '')) || fleetHardeningPlanDigest(plan) !== expectedDigest) {
    throw new Error('Fleet hardening plan digest mismatch');
  }
  const currentConfigDigest = fleetHardeningDigest(validateHardeningFleet(fleet));
  if (plan.config_sha256 !== currentConfigDigest) throw new Error('Fleet hardening config drifted after plan review');
  if (plan.implementation_sha256 !== implementationDigest) throw new Error('Fleet hardening implementation drifted after plan review');
  if (plan.environment !== expectedEnvironment) throw new Error(`Plan environment ${plan.environment} does not match ${expectedEnvironment}`);
  if (!['test', 'production'].includes(plan.environment)) throw new Error('Plan environment is invalid');
  if (!Array.isArray(plan.operations) || plan.operations.length !== plan.operation_count) throw new Error('Plan operation count is inconsistent');
  if (plan.operations.length > MAX_PLAN_OPERATIONS) throw new Error('Plan operation count exceeds the hard limit');
  const normalized = plan.operations.map(normalizeOperation);
  const uniqueKeys = new Set(normalized.map((operation) => `${operation.repository}:${operation.path}`));
  if (uniqueKeys.size !== normalized.length) throw new Error('Plan contains duplicate repository/path operations');
  return { plan, operations: normalized };
}

export function validateFleetHardeningCanaryReceipt(receipt, {
  expectedDigest,
  fleet,
  productionOrganization,
} = {}) {
  if (!isRecord(receipt) || receipt.schema !== 'ores.fleet-hardening-canary.v1') throw new Error('Unsupported canary receipt');
  if (!SHA256.test(String(expectedDigest ?? '')) || fleetHardeningDigest(receipt) !== expectedDigest) {
    throw new Error('Canary receipt digest mismatch');
  }
  if (receipt.status !== 'passed') throw new Error('Canary receipt must record passed status');
  const production = requireSingleOrganization(fleet, productionOrganization, 'production');
  if (!production.test_organization) throw new Error(`${production.name} has no configured test organization`);
  if (String(receipt.test_organization).toLowerCase() !== production.test_organization.toLowerCase()) {
    throw new Error('Canary receipt test organization does not match production pairing');
  }
  if (String(receipt.production_organization).toLowerCase() !== production.name.toLowerCase()) {
    throw new Error('Canary receipt production organization mismatch');
  }
  if (receipt.config_sha256 !== fleetHardeningDigest(fleet)) throw new Error('Canary receipt is for a stale fleet configuration');
  if (!Number.isSafeInteger(receipt.pull_request) || receipt.pull_request < 1) throw new Error('Canary receipt requires a test pull request number');
  if (!SHA.test(String(receipt.head_sha ?? ''))) throw new Error('Canary receipt requires an exact tested head SHA');
  return receipt;
}

export function branchForFleetHardeningPlan(planDigest) {
  if (!SHA256.test(String(planDigest ?? ''))) throw new Error('Invalid plan digest for branch naming');
  return `ores/fleet-hardening/${planDigest.slice('sha256:'.length, 'sha256:'.length + 20)}`;
}

async function getRef(client, token, owner, repo, branch) {
  return getBranchHead(client, token, owner, repo, branch);
}

async function createRef(client, token, owner, repo, branch, sha) {
  await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
    token,
    body: { ref: `refs/heads/${branch}`, sha },
  });
}

async function findPlanPullRequest(client, token, owner, repo, branch, base) {
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=10`,
    { token },
  );
  return Array.isArray(response.data) ? response.data[0] ?? null : null;
}

async function branchMatchesPlan(client, token, group, branch) {
  for (const operation of group.operations) {
    const file = await getRepositoryTextFile(client, token, {
      owner: group.owner,
      repo: group.repo,
      path: operation.path,
      ref: branch,
    });
    if (!file || contentDigest(canonicalText(file.content)) !== operation.contentDigest) return false;
  }
  return true;
}

function groupOperations(operations) {
  const byRepository = new Map();
  for (const operation of operations) {
    let group = byRepository.get(operation.repository);
    if (!group) {
      group = {
        repository: operation.repository,
        owner: operation.owner,
        repo: operation.repo,
        defaultBranch: operation.defaultBranch,
        expectedHead: operation.expectedHead,
        operations: [],
      };
      byRepository.set(operation.repository, group);
    }
    if (group.defaultBranch !== operation.defaultBranch || group.expectedHead !== operation.expectedHead) {
      throw new Error(`Plan contains inconsistent base identity for ${operation.repository}`);
    }
    group.operations.push(operation);
  }
  return [...byRepository.values()].sort((left, right) => left.repository.localeCompare(right.repository));
}

export async function applyFleetHardeningPlan(client, tokenForRepository, validated, {
  planDigest,
  changeTicket,
} = {}) {
  if (!/^HARDEN-[A-Za-z0-9._-]{1,96}$/u.test(String(changeTicket ?? ''))) {
    throw new Error('Apply requires an exact HARDEN-<change-ticket> acknowledgement');
  }
  const branch = branchForFleetHardeningPlan(planDigest);
  const groups = groupOperations(validated.operations);

  // Preflight every target before the first write. Any default-branch drift blocks
  // the entire plan rather than producing a partial rollout from stale evidence.
  for (const group of groups) {
    const token = await tokenForRepository(group.owner, group.repo);
    const liveHead = await getBranchHead(client, token, group.owner, group.repo, group.defaultBranch);
    if (liveHead !== group.expectedHead) {
      throw new Error(`${group.repository} default branch moved after plan review`);
    }
  }

  const ledger = [];
  for (const group of groups) {
    const token = await tokenForRepository(group.owner, group.repo);
    const existingRef = await getRef(client, token, group.owner, group.repo, branch);
    if (existingRef) {
      const matches = await branchMatchesPlan(client, token, group, branch);
      const pullRequest = await findPlanPullRequest(client, token, group.owner, group.repo, branch, group.defaultBranch);
      if (!matches || !pullRequest) throw new Error(`${group.repository} has a colliding or incomplete hardening branch`);
      ledger.push({
        repository: group.repository,
        branch,
        pull_request: pullRequest.number,
        url: pullRequest.html_url,
        action: 'reused',
        rollback: `close PR #${pullRequest.number} and delete refs/heads/${branch}`,
      });
      continue;
    }

    await createRef(client, token, group.owner, group.repo, branch, group.expectedHead);
    try {
      for (const operation of group.operations) {
        await upsertRepositoryTextFile(client, token, {
          owner: group.owner,
          repo: group.repo,
          path: operation.path,
          content: operation.content,
          message: `chore: propose fleet hardening (${changeTicket})`,
          branch,
          dryRun: false,
        });
      }
      const pullRequest = await client.request('POST', `/repos/${encodeURIComponent(group.owner)}/${encodeURIComponent(group.repo)}/pulls`, {
        token,
        body: {
          title: `chore: adopt reviewed fleet hardening plan`,
          head: branch,
          base: group.defaultBranch,
          body: [
            `Automated proposal from reviewed fleet-hardening plan.`,
            '',
            `Plan digest: \`${planDigest}\``,
            `Change ticket: \`${changeTicket}\``,
            `Expected base head: \`${group.expectedHead}\``,
            '',
            'This PR is additive only. Normal repository CI, CODEOWNERS, review, and merge policy still apply.',
          ].join('\n'),
        },
      });
      ledger.push({
        repository: group.repository,
        branch,
        pull_request: pullRequest.data.number,
        url: pullRequest.data.html_url,
        action: 'opened',
        rollback: `close PR #${pullRequest.data.number} and delete refs/heads/${branch}`,
      });
    } catch (error) {
      ledger.push({
        repository: group.repository,
        branch,
        pull_request: null,
        url: null,
        action: 'partial',
        error_status: Number(error?.status) || null,
        rollback: `delete refs/heads/${branch} after inspecting the partial proposal branch`,
      });
      return { ok: false, ledger };
    }
  }
  return { ok: true, ledger };
}
