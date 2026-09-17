import { normalizeDependencyVersion, pullRequestDependencyKey } from '../../core/src/pr-dependencies.mjs';

const VERSION_PATHS = Object.freeze([
  '.zpkg.toml',
  'package.json',
  'Cargo.toml',
  'pubspec.yaml',
  'gleam.toml',
]);

function dependencyCoordinates(dependency) {
  const owner = String(dependency.owner ?? dependency.dependencyOwner ?? '').toLowerCase();
  const repo = String(dependency.repo ?? dependency.dependencyRepo ?? '').toLowerCase();
  const prNumber = Number(dependency.prNumber ?? dependency.dependencyPrNumber);
  const expectedVersion = normalizeDependencyVersion(dependency.expectedVersion ?? null);
  return Object.freeze({
    owner,
    repo,
    prNumber,
    expectedVersion,
    key: pullRequestDependencyKey(owner, repo, prNumber),
  });
}

function githubStatus(error) {
  return Number(error?.status ?? error?.response?.status ?? 0);
}

async function readTextAtRef(client, token, owner, repo, path, ref) {
  try {
    const response = await client.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      { token },
    );
    if (response.data?.type !== 'file' || response.data?.encoding !== 'base64' || typeof response.data?.content !== 'string') {
      throw new Error(`${path} is not a base64 GitHub contents file`);
    }
    return Buffer.from(response.data.content.replace(/\s/gu, ''), 'base64').toString('utf8');
  } catch (error) {
    if (githubStatus(error) === 404) return null;
    throw error;
  }
}

function tomlVersion(text, section = null) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const initial = Object.freeze({ active: section === null, version: null });
  return lines.reduce((state, raw) => {
    if (state.version !== null) return state;
    const line = raw.replace(/(^|\s)#.*$/u, '').trim();
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) return Object.freeze({ ...state, active: section !== null && header[1].trim() === section });
    if (!state.active) return state;
    const match = /^version\s*=\s*["']([^"']+)["']\s*$/u.exec(line);
    return match ? Object.freeze({ ...state, version: normalizeDependencyVersion(match[1]) }) : state;
  }, initial).version;
}

function manifestVersion(path, text) {
  if (path === '.zpkg.toml') return tomlVersion(text);
  if (path === 'package.json') {
    try {
      const parsed = JSON.parse(text);
      return normalizeDependencyVersion(parsed?.version ?? null);
    } catch {
      return null;
    }
  }
  if (path === 'Cargo.toml') return tomlVersion(text, 'package');
  if (path === 'pubspec.yaml') {
    const match = /^version\s*:\s*([^\s#]+)\s*(?:#.*)?$/imu.exec(text);
    return normalizeDependencyVersion(match?.[1] ?? null);
  }
  if (path === 'gleam.toml') return tomlVersion(text);
  return null;
}

export async function resolvePullRequestHeadVersion(client, token, owner, repo, headSha) {
  for (const path of VERSION_PATHS) {
    const text = await readTextAtRef(client, token, owner, repo, path, headSha);
    if (text === null) continue;
    const version = manifestVersion(path, text);
    if (version !== null) return Object.freeze({ version, source: path });
  }
  return null;
}

async function findTrustedGate(client, token, dependency, headSha, gateAppId) {
  const externalId = `gate:${dependency.owner}/${dependency.repo}#${dependency.prNumber}@${headSha}`;
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(dependency.owner)}/${encodeURIComponent(dependency.repo)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent('ores-review/gate')}&filter=latest&per_page=100`,
    { token },
  );
  const matchingExternal = (response.data?.check_runs ?? [])
    .filter((check) => check.external_id === externalId)
    .sort((left, right) => Number(right.id) - Number(left.id));
  const trusted = matchingExternal.find((check) => Number(check?.app?.id) === Number(gateAppId)) ?? null;
  return Object.freeze({ trusted, matchingExternal, externalId });
}

function trustedGateState(result) {
  if (!result.trusted) {
    return result.matchingExternal.length > 0
      ? Object.freeze({ state: 'failure', reason: 'upstream gate App identity mismatch' })
      : Object.freeze({ state: 'pending', reason: 'upstream exact-head ORES gate is missing' });
  }
  const gate = result.trusted;
  if (gate.status !== 'completed') return Object.freeze({ state: 'pending', reason: `upstream gate ${gate.status ?? 'pending'}` });
  if (gate.conclusion !== 'success') return Object.freeze({ state: 'failure', reason: `upstream gate conclusion=${gate.conclusion ?? 'failure'}` });
  return Object.freeze({ state: 'success', reason: 'upstream exact-head ORES gate passed' });
}

export async function evaluatePullRequestDependency({ client, auth, gateAppId, dependency }) {
  const coordinates = dependencyCoordinates(dependency);
  try {
    const access = await auth.repoToken('orchestrator', coordinates.owner, coordinates.repo);
    const response = await client.request(
      'GET',
      `/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repo)}/pulls/${coordinates.prNumber}`,
      { token: access.token },
    );
    const pullRequest = response.data;
    const headSha = String(pullRequest?.head?.sha ?? '');
    if (!/^[a-f0-9]{40}$/iu.test(headSha)) {
      return Object.freeze({ dependency: coordinates.key, state: 'failure', reason: 'upstream PR head SHA is invalid' });
    }
    if (pullRequest?.draft) {
      return Object.freeze({ dependency: coordinates.key, state: 'pending', reason: 'upstream PR is draft', headSha });
    }
    if (pullRequest?.state === 'closed' && pullRequest?.merged !== true && !pullRequest?.merged_at) {
      return Object.freeze({ dependency: coordinates.key, state: 'failure', reason: 'upstream PR closed without merge', headSha });
    }
    if (!['open', 'closed'].includes(String(pullRequest?.state ?? ''))) {
      return Object.freeze({ dependency: coordinates.key, state: 'failure', reason: `upstream PR state=${pullRequest?.state ?? 'unknown'}`, headSha });
    }

    const gateEvidence = await findTrustedGate(client, access.token, coordinates, headSha, gateAppId);
    const gateState = trustedGateState(gateEvidence);
    if (gateState.state !== 'success') {
      return Object.freeze({
        dependency: coordinates.key,
        ...gateState,
        headSha,
        expectedVersion: coordinates.expectedVersion,
      });
    }

    if (coordinates.expectedVersion === null) {
      return Object.freeze({
        dependency: coordinates.key,
        state: 'success',
        reason: 'upstream exact-head ORES gate passed',
        headSha,
        expectedVersion: null,
      });
    }

    const versionEvidence = await resolvePullRequestHeadVersion(
      client,
      access.token,
      coordinates.owner,
      coordinates.repo,
      headSha,
    );
    if (!versionEvidence) {
      return Object.freeze({
        dependency: coordinates.key,
        state: 'failure',
        reason: `required version ${coordinates.expectedVersion} has no machine-readable upstream manifest evidence`,
        headSha,
        expectedVersion: coordinates.expectedVersion,
      });
    }
    if (versionEvidence.version !== coordinates.expectedVersion) {
      return Object.freeze({
        dependency: coordinates.key,
        state: 'failure',
        reason: `required version ${coordinates.expectedVersion}, upstream ${versionEvidence.source} declares ${versionEvidence.version}`,
        headSha,
        expectedVersion: coordinates.expectedVersion,
        actualVersion: versionEvidence.version,
        versionSource: versionEvidence.source,
      });
    }
    return Object.freeze({
      dependency: coordinates.key,
      state: 'success',
      reason: `upstream exact-head gate passed at version ${versionEvidence.version}`,
      headSha,
      expectedVersion: coordinates.expectedVersion,
      actualVersion: versionEvidence.version,
      versionSource: versionEvidence.source,
    });
  } catch (error) {
    const status = githubStatus(error);
    const reason = status === 404
      ? 'upstream PR or repository is inaccessible or missing'
      : `upstream dependency verification error: ${error instanceof Error ? error.message : String(error)}`;
    return Object.freeze({ dependency: coordinates.key, state: 'failure', reason });
  }
}

export async function evaluatePullRequestDependencies({ client, auth, gateAppId, dependencies }) {
  const results = [];
  for (const dependency of dependencies ?? []) {
    results.push(await evaluatePullRequestDependency({ client, auth, gateAppId, dependency }));
  }
  return Object.freeze(results);
}
