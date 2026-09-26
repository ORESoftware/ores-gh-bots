// Read-only inventory of the configured App's visibility, not an ownership claim.
function repositoryRecord(repository, installation) {
  const owner = installation.account.login;
  if (!Number.isSafeInteger(repository?.id) || repository.id < 1
      || typeof repository.name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repository.name)
      || repository.owner?.login?.toLowerCase() !== owner.toLowerCase()
      || repository.full_name?.toLowerCase() !== `${owner}/${repository.name}`.toLowerCase()
      || typeof repository.private !== 'boolean' || typeof repository.archived !== 'boolean'
      || typeof repository.disabled !== 'boolean') {
    throw new Error('Invalid installation repository identity');
  }
  return {
    id: repository.id,
    full_name: repository.full_name,
    installation_id: installation.id,
    default_branch: typeof repository.default_branch === 'string' ? repository.default_branch : null,
    private: repository.private,
    archived: repository.archived,
    disabled: repository.disabled,
    role: null,
    contract_authorities: null,
    dependencies: null,
    supported_languages: null,
    release_mechanism: null,
  };
}

async function inspectInstallation({ client, auth, installation, maxPages }) {
  const identity = { id: installation.id, owner: installation.account.login,
    repository_selection: installation.repository_selection ?? 'unknown' };
  if (installation.suspended_at) {
    return { ...identity, status: 'suspended', repositories: [] };
  }
  try {
    const token = await auth.installationToken('orchestrator', installation.id);
    const pages = await client.paginate('/installation/repositories?per_page=100', {
      token, maxPages, requireComplete: true,
      map: (data) => [{ total: data?.total_count, repositories: data?.repositories }],
    });
    if (pages.length === 0 || pages.some((page) => !Number.isSafeInteger(page.total) || page.total < 0
        || page.total !== pages[0].total || !Array.isArray(page.repositories))) {
      throw new Error('Invalid or changing repository pagination totals');
    }
    const repositories = pages.flatMap((page) => page.repositories);
    if (repositories.length !== pages[0].total) {
      throw new Error('Incomplete installation repository enumeration');
    }
    const records = repositories.map((repository) => repositoryRecord(repository, installation));
    if (new Set(records.map((record) => record.id)).size !== records.length
        || new Set(records.map((record) => record.full_name.toLowerCase())).size !== records.length) {
      throw new Error('Duplicate installation repository identity');
    }
    return { ...identity, status: 'enumerated', repositories: records };
  } catch {
    // Provider errors can carry headers, tokens and private response bodies.
    return { ...identity, status: 'uninspected', repositories: [] };
  }
}

export async function collectFleetInventory({ client, auth, ownerIsAllowed, expectedOwners = [], maxPages = 100 }) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1
      || !Array.isArray(expectedOwners)
      || expectedOwners.some((owner) => typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner))) {
    throw new TypeError('Invalid inventory page ceiling or expected owner list');
  }
  const installations = await client.paginate('/app/installations?per_page=100', {
    token: auth.appJwt('orchestrator'), map: (data) => data, maxPages, requireComplete: true,
  });
  if (installations.some((installation) => !Number.isSafeInteger(installation?.id) || installation.id < 1
      || typeof installation.account?.login !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(installation.account.login))
      || new Set(installations.map((installation) => installation.id)).size !== installations.length) {
    throw new Error('Invalid or duplicate installation identity');
  }
  const selected = installations.filter((installation) => ownerIsAllowed(installation.account.login));
  // Sequential requests bound credential minting and avoid a fleet-sized burst.
  const inspected = await selected.reduce(async (pending, installation) => {
    const previous = await pending;
    const result = await inspectInstallation({ client, auth, installation, maxPages });
    return [...previous, result];
  }, Promise.resolve([]));
  const observed = new Set(selected.map((installation) => installation.account.login.toLowerCase()));
  const missingOwners = [...new Set(expectedOwners.map((owner) => owner.toLowerCase()))]
    .filter((owner) => !observed.has(owner)).sort();
  const repositories = inspected.flatMap((installation) => installation.repositories)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  return {
    scope: 'configured-app-visibility',
    enumeration_complete: missingOwners.length === 0 && inspected.every((entry) => entry.status === 'enumerated'),
    ownership_inventory_complete: false,
    missing_expected_owners: missingOwners,
    installations: inspected.map(({ repositories: records, ...entry }) => ({ ...entry, repository_count: records.length }))
      .sort((a, b) => a.owner.localeCompare(b.owner)),
    repository_count: repositories.length,
    repositories,
  };
}
