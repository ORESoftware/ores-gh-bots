export async function listAppInstallations(client, appJwt) {
  return client.paginate('/app/installations?per_page=100', { token: appJwt, map: (data) => data });
}

export async function listInstallationRepositories(client, installationToken, maxRepos = 10_000) {
  const repositories = await client.paginate('/installation/repositories?per_page=100', {
    token: installationToken,
    map: (data) => data.repositories,
    maxPages: Math.max(1, Math.ceil(maxRepos / 100)),
  });
  return repositories.slice(0, maxRepos);
}

export function repositoryMatchesFleet(repository, { ownerIsAllowed, excludePatterns = [] }) {
  const owner = repository.owner?.login;
  if (!ownerIsAllowed(owner)) return false;
  return !excludePatterns.some((pattern) => pattern.test(repository.name));
}
