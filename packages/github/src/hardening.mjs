import { GitHubHttpError } from './client.mjs';

const TEXT_ENCODER = new TextEncoder();

function encodeRepositoryPath(path) {
  return String(path)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function base64EncodeUtf8(value) {
  return Buffer.from(TEXT_ENCODER.encode(String(value))).toString('base64');
}

function base64DecodeUtf8(value) {
  return Buffer.from(String(value).replace(/\n/g, ''), 'base64').toString('utf8');
}

function canonicalText(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\s+$/u, '') + '\n';
}

export function normalizeSqlNamespace(value) {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!normalized) throw new Error(`Cannot derive SQL namespace from ${JSON.stringify(value)}`);
  if (/^[0-9]/.test(normalized)) return `org_${normalized}`.slice(0, 63).replace(/_+$/g, '');
  return normalized.slice(0, 63).replace(/_+$/g, '');
}

export function validateHardeningFleet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hardening fleet config must be an object');
  if (value.api_version !== 'ores.dev/fleet-hardening/v1') throw new Error('Unsupported hardening fleet api_version');
  if (!value.central || typeof value.central !== 'object') throw new Error('Hardening fleet central configuration is required');
  if (!value.defaults || typeof value.defaults !== 'object') throw new Error('Hardening fleet defaults are required');
  if (!Array.isArray(value.organizations) || value.organizations.length === 0) throw new Error('Hardening fleet organizations must be non-empty');

  const names = new Set();
  const namespaces = new Set();
  for (const organization of value.organizations) {
    const name = String(organization?.name ?? '').trim();
    if (!name) throw new Error('Each organization requires a name');
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate organization: ${name}`);
    names.add(key);

    const namespace = organization.namespace ?? normalizeSqlNamespace(name.replace(/-test$/i, ''));
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)) throw new Error(`Invalid SQL namespace for ${name}: ${namespace}`);
    const namespaceKey = `${namespace}:${organization.environment ?? 'production'}`;
    if (namespaces.has(namespaceKey)) throw new Error(`Duplicate SQL namespace/environment pair: ${namespaceKey}`);
    namespaces.add(namespaceKey);

    if (organization.required_repositories && !Array.isArray(organization.required_repositories)) {
      throw new Error(`required_repositories must be an array for ${name}`);
    }
  }
  return value;
}

export function organizationPolicyDocument(fleet, organization) {
  const defaults = fleet.defaults;
  const environment = organization.environment ?? (/\-test$/i.test(organization.name) ? 'test' : 'production');
  const namespace = organization.namespace ?? normalizeSqlNamespace(organization.name.replace(/-test$/i, ''));
  return {
    api_version: fleet.api_version,
    kind: 'OrganizationHardeningPolicy',
    metadata: {
      organization: organization.name,
      environment,
      sql_namespace: namespace,
      managed_by: fleet.central.policy_repository,
    },
    spec: {
      repository_scope: organization.repository_scope ?? defaults.repository_scope,
      required_capabilities: organization.required_capabilities ?? defaults.required_capabilities,
      required_checks: organization.required_checks ?? defaults.required_checks,
      repository_roles: organization.repository_roles ?? defaults.repository_roles,
      required_repositories: organization.required_repositories ?? [],
      test_organization: organization.test_organization ?? null,
      production_organization: organization.production_organization ?? null,
      sql: {
        ...defaults.sql,
        ...(organization.sql ?? {}),
        namespace,
      },
      infrastructure: {
        ...defaults.infrastructure,
        ...(organization.infrastructure ?? {}),
      },
      observability: {
        ...defaults.observability,
        ...(organization.observability ?? {}),
      },
      dependency_management: {
        ...defaults.dependency_management,
        ...(organization.dependency_management ?? {}),
      },
      promotion: {
        ...defaults.promotion,
        ...(organization.promotion ?? {}),
      },
    },
  };
}

export function repositoryPolicyDocument(fleet, organization, repository) {
  const organizationPolicy = organizationPolicyDocument(fleet, organization);
  return {
    api_version: fleet.api_version,
    kind: 'RepositoryHardeningPolicy',
    metadata: {
      organization: organization.name,
      repository: repository.name,
      default_branch: repository.default_branch ?? null,
      sql_namespace: organizationPolicy.metadata.sql_namespace,
      managed_by: fleet.central.policy_repository,
    },
    spec: organizationPolicy.spec,
  };
}

export async function getRepository(client, token, owner, repo) {
  try {
    return (await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })).data;
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function ensureOrganizationRepository(client, token, {
  owner,
  name,
  description,
  private: isPrivate = true,
  visibility,
  dryRun = true,
}) {
  const existing = await getRepository(client, token, owner, name);
  if (existing) return { action: 'unchanged', repository: existing.full_name, id: existing.id };
  if (dryRun) return { action: 'create', repository: `${owner}/${name}`, dry_run: true };
  const body = {
    name,
    description,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    auto_init: true,
    delete_branch_on_merge: true,
  };
  if (visibility) body.visibility = visibility;
  else body.private = Boolean(isPrivate);
  const response = await client.request('POST', `/orgs/${encodeURIComponent(owner)}/repos`, { token, body });
  return { action: 'created', repository: response.data.full_name, id: response.data.id };
}

export async function getRepositoryTextFile(client, token, { owner, repo, path, ref }) {
  const encodedPath = encodeRepositoryPath(path);
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  try {
    const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${suffix}`, { token });
    if (Array.isArray(response.data) || response.data?.type !== 'file') throw new Error(`${owner}/${repo}:${path} is not a file`);
    return {
      content: base64DecodeUtf8(response.data.content ?? ''),
      sha: response.data.sha,
      path: response.data.path,
    };
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function upsertRepositoryTextFile(client, token, {
  owner,
  repo,
  path,
  content,
  message,
  branch,
  dryRun = true,
}) {
  const normalized = canonicalText(content);
  const existing = await getRepositoryTextFile(client, token, { owner, repo, path, ref: branch });
  if (existing && canonicalText(existing.content) === normalized) {
    return { action: 'unchanged', repository: `${owner}/${repo}`, path };
  }
  const action = existing ? 'update' : 'create';
  if (dryRun) return { action, repository: `${owner}/${repo}`, path, dry_run: true };
  const body = {
    message,
    content: base64EncodeUtf8(normalized),
  };
  if (branch) body.branch = branch;
  if (existing?.sha) body.sha = existing.sha;
  const response = await client.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepositoryPath(path)}`, { token, body });
  return {
    action: `${action}d`,
    repository: `${owner}/${repo}`,
    path,
    commit_sha: response.data?.commit?.sha ?? null,
  };
}

export async function listOrganizationRepositories(client, token, owner, maxRepositories = 10_000) {
  const repositories = await client.paginate(`/orgs/${encodeURIComponent(owner)}/repos?type=all&per_page=100`, {
    token,
    map: (data) => data,
    maxPages: Math.max(1, Math.ceil(maxRepositories / 100)),
  });
  return repositories.slice(0, maxRepositories);
}

export async function applyOrganizationHardening(client, token, fleet, organization, {
  dryRun = true,
  ensureRepositories = false,
  includeRepositories = false,
  maxRepositories = 10_000,
  continueOnError = false,
} = {}) {
  validateHardeningFleet(fleet);
  const results = [];
  const policyRepository = organization.policy_repository ?? fleet.defaults.policy_repository ?? '.github';
  const policyPath = organization.policy_path ?? fleet.defaults.policy_path ?? 'policy/ores-fleet-hardening.v1.json';

  if (ensureRepositories) {
    results.push(await ensureOrganizationRepository(client, token, {
      owner: organization.name,
      name: policyRepository,
      description: 'Organization-wide ORES policy, reusable workflows, and community health files.',
      private: false,
      visibility: 'public',
      dryRun,
    }));
    for (const repository of organization.required_repositories ?? []) {
      try {
        results.push(await ensureOrganizationRepository(client, token, {
          owner: organization.name,
          name: repository.name ?? repository,
          description: repository.description ?? `Managed repository required by ${fleet.api_version}.`,
          private: repository.private ?? true,
          visibility: repository.visibility,
          dryRun,
        }));
      } catch (error) {
        results.push({ repository: `${organization.name}/${repository.name ?? repository}`, error: error.message, status: error.status ?? null });
        if (!continueOnError) throw error;
      }
    }
  }

  const policy = organizationPolicyDocument(fleet, organization);
  results.push(await upsertRepositoryTextFile(client, token, {
    owner: organization.name,
    repo: policyRepository,
    path: policyPath,
    content: JSON.stringify(policy, null, 2),
    message: `chore: adopt ${fleet.api_version}`,
    dryRun,
  }));

  if (includeRepositories) {
    const repositories = await listOrganizationRepositories(client, token, organization.name, maxRepositories);
    for (const repository of repositories) {
      if (repository.archived || repository.disabled || repository.name === policyRepository) continue;
      try {
        const policyDocument = repositoryPolicyDocument(fleet, organization, repository);
        results.push(await upsertRepositoryTextFile(client, token, {
          owner: organization.name,
          repo: repository.name,
          path: fleet.defaults.repository_policy_path ?? '.ores/repository-hardening.v1.json',
          content: JSON.stringify(policyDocument, null, 2),
          message: `chore: adopt ${fleet.api_version}`,
          branch: repository.default_branch,
          dryRun,
        }));
      } catch (error) {
        results.push({ repository: repository.full_name, error: error.message, status: error.status ?? null });
        if (!continueOnError) throw error;
      }
    }
  }
  return results;
}
