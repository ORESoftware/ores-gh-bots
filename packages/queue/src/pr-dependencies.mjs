import { normalizeDependencyVersion, pullRequestDependencyKey } from '../../core/src/pr-dependencies.mjs';

const GATE_EXTERNAL_ID = /^gate:([^/]+)\/([^#]+)#([1-9]\d*)@([a-f0-9]{40})$/iu;

function database(queue) {
  if (!queue?.db || typeof queue.db.exec !== 'function') throw new Error('PR dependency store requires the SQLite queue');
  queue.db.exec(`
    CREATE TABLE IF NOT EXISTS pr_dependencies (
      dependent_owner TEXT NOT NULL,
      dependent_repo TEXT NOT NULL,
      dependent_pr_number INTEGER NOT NULL,
      dependent_head_sha TEXT NOT NULL,
      dependent_installation_id INTEGER NOT NULL,
      dependency_owner TEXT NOT NULL,
      dependency_repo TEXT NOT NULL,
      dependency_pr_number INTEGER NOT NULL,
      expected_version TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(
        dependent_owner, dependent_repo, dependent_pr_number,
        dependency_owner, dependency_repo, dependency_pr_number
      )
    );
    CREATE INDEX IF NOT EXISTS pr_dependencies_reverse_idx
      ON pr_dependencies(dependency_owner, dependency_repo, dependency_pr_number);
  `);
  return queue.db;
}

function normalizeEdge(edge) {
  const dependentOwner = String(edge.dependentOwner ?? '').trim().toLowerCase();
  const dependentRepo = String(edge.dependentRepo ?? '').trim().toLowerCase();
  const dependentPrNumber = Number(edge.dependentPrNumber);
  const dependentHeadSha = String(edge.dependentHeadSha ?? '').trim().toLowerCase();
  const dependentInstallationId = Number(edge.dependentInstallationId);
  const dependencyOwner = String(edge.dependencyOwner ?? '').trim().toLowerCase();
  const dependencyRepo = String(edge.dependencyRepo ?? '').trim().toLowerCase();
  const dependencyPrNumber = Number(edge.dependencyPrNumber);
  const expectedVersion = normalizeDependencyVersion(edge.expectedVersion ?? null);
  pullRequestDependencyKey(dependentOwner, dependentRepo, dependentPrNumber);
  pullRequestDependencyKey(dependencyOwner, dependencyRepo, dependencyPrNumber);
  if (!/^[a-f0-9]{40}$/iu.test(dependentHeadSha)) throw new Error('dependent head SHA is invalid');
  if (!Number.isSafeInteger(dependentInstallationId) || dependentInstallationId < 1) {
    throw new Error('dependent installation id is invalid');
  }
  return Object.freeze({
    dependentOwner,
    dependentRepo,
    dependentPrNumber,
    dependentHeadSha,
    dependentInstallationId,
    dependencyOwner,
    dependencyRepo,
    dependencyPrNumber,
    expectedVersion,
  });
}

function rowKeys(row) {
  return {
    from: pullRequestDependencyKey(row.dependent_owner, row.dependent_repo, row.dependent_pr_number),
    to: pullRequestDependencyKey(row.dependency_owner, row.dependency_repo, row.dependency_pr_number),
  };
}

function addAdjacencyEdge(graph, from, to) {
  const nextTargets = new Set([...(graph.get(from) ?? []), to]);
  return new Map([...graph, [from, nextTargets]]);
}

function rowsToAdjacency(rows) {
  return rows.reduce((graph, row) => {
    const { from, to } = rowKeys(row);
    return addAdjacencyEdge(graph, from, to);
  }, new Map());
}

function reaches(graph, start, target, seen = new Set()) {
  if (start === target) return true;
  if (seen.has(start)) return false;
  const nextSeen = new Set([...seen, start]);
  return [...(graph.get(start) ?? [])].some((next) => reaches(graph, next, target, nextSeen));
}

function edgeKey(edge) {
  return pullRequestDependencyKey(edge.dependencyOwner, edge.dependencyRepo, edge.dependencyPrNumber);
}

function selectAcyclicEdges(baseGraph, dependentKey, edges) {
  return edges.reduce((state, edge) => {
    const dependencyKey = edgeKey(edge);
    const cyclic = dependencyKey === dependentKey || reaches(state.graph, dependencyKey, dependentKey);
    if (cyclic) {
      return Object.freeze({
        graph: state.graph,
        accepted: state.accepted,
        ignored: Object.freeze([...state.ignored, Object.freeze({ ...edge, reason: 'cycle' })]),
      });
    }
    return Object.freeze({
      graph: addAdjacencyEdge(state.graph, dependentKey, dependencyKey),
      accepted: Object.freeze([...state.accepted, edge]),
      ignored: state.ignored,
    });
  }, Object.freeze({ graph: baseGraph, accepted: Object.freeze([]), ignored: Object.freeze([]) }));
}

export function clearPullRequestDependencies(queue, { owner, repo, prNumber }) {
  pullRequestDependencyKey(owner, repo, prNumber);
  const db = database(queue);
  const result = db.prepare(`
    DELETE FROM pr_dependencies
    WHERE dependent_owner = ? AND dependent_repo = ? AND dependent_pr_number = ?
  `).run(String(owner).toLowerCase(), String(repo).toLowerCase(), Number(prNumber));
  return Object.freeze({ removed: Number(result.changes) });
}

export function replacePullRequestDependencies(queue, {
  dependentOwner,
  dependentRepo,
  dependentPrNumber,
  dependentHeadSha,
  dependentInstallationId,
  declarations,
}) {
  const db = database(queue);
  const normalized = (declarations ?? []).map((declaration) => normalizeEdge({
    dependentOwner,
    dependentRepo,
    dependentPrNumber,
    dependentHeadSha,
    dependentInstallationId,
    dependencyOwner: declaration.owner,
    dependencyRepo: declaration.repo,
    dependencyPrNumber: declaration.prNumber,
    expectedVersion: declaration.expectedVersion,
  }));
  const byDependency = normalized.reduce((map, edge) => {
    const key = edgeKey(edge);
    const existing = map.get(key);
    if (existing && existing.expectedVersion !== edge.expectedVersion) {
      throw new Error(`Conflicting version requirements for ${key}`);
    }
    return existing ? map : new Map([...map, [key, edge]]);
  }, new Map());
  const canonicalEdges = Object.freeze(
    [...byDependency.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
  );
  const dependentKey = pullRequestDependencyKey(dependentOwner, dependentRepo, dependentPrNumber);

  db.exec('BEGIN IMMEDIATE');
  try {
    const retained = db.prepare(`
      SELECT * FROM pr_dependencies
      WHERE NOT (dependent_owner = ? AND dependent_repo = ? AND dependent_pr_number = ?)
    `).all(String(dependentOwner).toLowerCase(), String(dependentRepo).toLowerCase(), Number(dependentPrNumber));
    const selected = selectAcyclicEdges(rowsToAdjacency(retained), dependentKey, canonicalEdges);

    db.prepare(`
      DELETE FROM pr_dependencies
      WHERE dependent_owner = ? AND dependent_repo = ? AND dependent_pr_number = ?
    `).run(String(dependentOwner).toLowerCase(), String(dependentRepo).toLowerCase(), Number(dependentPrNumber));
    const insert = db.prepare(`
      INSERT INTO pr_dependencies(
        dependent_owner, dependent_repo, dependent_pr_number, dependent_head_sha, dependent_installation_id,
        dependency_owner, dependency_repo, dependency_pr_number, expected_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = Date.now();
    selected.accepted.forEach((edge) => insert.run(
      edge.dependentOwner,
      edge.dependentRepo,
      edge.dependentPrNumber,
      edge.dependentHeadSha,
      edge.dependentInstallationId,
      edge.dependencyOwner,
      edge.dependencyRepo,
      edge.dependencyPrNumber,
      edge.expectedVersion,
      timestamp,
    ));
    db.exec('COMMIT');
    return Object.freeze({
      count: selected.accepted.length,
      accepted: selected.accepted,
      ignored: selected.ignored,
    });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function gateCoordinates(payload, expectedGateAppId) {
  if (!['created', 'rerequested', 'completed'].includes(String(payload?.action ?? ''))) return null;
  const check = payload?.check_run;
  if (check?.name !== 'ores-review/gate') return null;
  if (expectedGateAppId !== null && expectedGateAppId !== undefined && Number(check?.app?.id) !== Number(expectedGateAppId)) {
    return null;
  }

  const repositoryOwner = String(payload.repository?.owner?.login ?? '').toLowerCase();
  const repositoryName = String(payload.repository?.name ?? '').toLowerCase();
  const externalId = String(check?.external_id ?? '');
  const match = GATE_EXTERNAL_ID.exec(externalId);
  if (!match) return null;
  const [, owner, repo, rawPrNumber, headSha] = match;
  if (owner.toLowerCase() !== repositoryOwner || repo.toLowerCase() !== repositoryName) return null;
  if (String(check?.head_sha ?? '').toLowerCase() !== headSha.toLowerCase()) return null;
  return { owner: repositoryOwner, repo: repositoryName, prNumber: Number(rawPrNumber) };
}

function upstreamCoordinates(event, payload, expectedGateAppId) {
  if (event === 'pull_request' && payload?.pull_request?.number) {
    return {
      owner: payload.repository?.owner?.login,
      repo: payload.repository?.name,
      prNumber: payload.pull_request.number,
    };
  }
  if (event === 'check_run') return gateCoordinates(payload, expectedGateAppId);
  return null;
}

export function dependentGateJobsForWebhook(queue, { event, payload, expectedGateAppId = null }) {
  const upstream = upstreamCoordinates(event, payload, expectedGateAppId);
  if (!upstream?.owner || !upstream.repo || !upstream.prNumber) return [];
  const db = database(queue);
  const rows = db.prepare(`
    SELECT DISTINCT dependent_owner, dependent_repo, dependent_pr_number,
      dependent_head_sha, dependent_installation_id
    FROM pr_dependencies
    WHERE dependency_owner = ? AND dependency_repo = ? AND dependency_pr_number = ?
    ORDER BY dependent_owner, dependent_repo, dependent_pr_number
  `).all(String(upstream.owner).toLowerCase(), String(upstream.repo).toLowerCase(), Number(upstream.prNumber));
  const reason = `dependency.${event}.${payload?.action ?? 'unknown'}:${String(upstream.owner).toLowerCase()}/${String(upstream.repo).toLowerCase()}#${Number(upstream.prNumber)}`;
  return rows.map((row) => Object.freeze({
    type: 'gate',
    installationId: Number(row.dependent_installation_id),
    owner: row.dependent_owner,
    repo: row.dependent_repo,
    prNumber: Number(row.dependent_pr_number),
    headSha: row.dependent_head_sha,
    reason,
    force: true,
  }));
}
