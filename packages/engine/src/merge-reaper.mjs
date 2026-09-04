const DEPENDENCY_DIRECTIVE = /^(?:depends-on|dependency|merge-after|requires|stacked-on)\s*:\s*(.+)$/gimu;
const FULL_DEPENDENCY = /(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull\/|#)([1-9]\d*)/gu;
const LOCAL_DEPENDENCY = /(?:^|[\s,])#([1-9]\d*)(?=$|[\s,])/gu;

export const DEFAULT_REAPER_POLICY = Object.freeze({
  version: 1,
  minimumAgeHours: 55,
  maxMerges: 3,
  maxRepositories: 2_000,
  maxPullRequestsPerRepository: 100,
  mergeMethod: 'squash',
  allowedBaseBranches: Object.freeze(['main', 'master', 'dev', 'develop']),
  requireOptInLabel: true,
  optInLabels: Object.freeze(['automerge', 'merge-when-ready', 'ores-automerge']),
  denyLabels: Object.freeze([
    'blocked',
    'do-not-merge',
    'hold',
    'legal-review',
    'manual-merge',
    'needs-security-review',
    'no-automerge',
    'security-review',
  ]),
  requireHumanApproval: false,
  ignoredCiContexts: Object.freeze([]),
  repositoryDependencies: Object.freeze({}),
});

function cleanString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  return text;
}

function positiveInteger(value, field, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function uniqueStrings(values, field, { lowerCase = false } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  const normalized = values.map((value, index) => cleanString(value, `${field}[${index}]`));
  const transformed = lowerCase ? normalized.map((value) => value.toLowerCase()) : normalized;
  if (new Set(transformed).size !== transformed.length) throw new Error(`${field} must not contain duplicates`);
  return transformed;
}

function normalizeRepository(value, field = 'repository') {
  const repository = cleanString(value, field);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`${field} must be OWNER/REPO`);
  }
  return repository.toLowerCase();
}

function normalizeRepositoryDependencies(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('repositoryDependencies must be an object');
  }
  const result = {};
  for (const [repository, dependencies] of Object.entries(value)) {
    const normalizedRepository = normalizeRepository(repository, 'repositoryDependencies key');
    const normalizedDependencies = uniqueStrings(dependencies, `repositoryDependencies.${repository}`)
      .map((dependency) => normalizeRepository(dependency, `repositoryDependencies.${repository}`));
    if (normalizedDependencies.includes(normalizedRepository)) {
      throw new Error(`repositoryDependencies.${repository} must not depend on itself`);
    }
    result[normalizedRepository] = normalizedDependencies;
  }
  topologicallyOrderRepositories(Object.keys(result), result);
  return result;
}

export function validateMergeReaperPolicy(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Merge reaper policy must be an object');
  }
  const allowedKeys = new Set([
    '$schema',
    'version',
    'minimumAgeHours',
    'maxMerges',
    'maxRepositories',
    'maxPullRequestsPerRepository',
    'mergeMethod',
    'allowedBaseBranches',
    'requireOptInLabel',
    'optInLabels',
    'denyLabels',
    'requireHumanApproval',
    'ignoredCiContexts',
    'repositoryDependencies',
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`Unknown merge reaper policy fields: ${unknownKeys.join(', ')}`);
  const merged = { ...DEFAULT_REAPER_POLICY, ...input };
  if (merged.version !== 1) throw new Error('Merge reaper policy version must be 1');
  const policy = {
    version: 1,
    minimumAgeHours: positiveInteger(merged.minimumAgeHours, 'minimumAgeHours', { maximum: 24 * 365 }),
    maxMerges: positiveInteger(merged.maxMerges, 'maxMerges', { maximum: 3 }),
    maxRepositories: positiveInteger(merged.maxRepositories, 'maxRepositories', { maximum: 10_000 }),
    maxPullRequestsPerRepository: positiveInteger(
      merged.maxPullRequestsPerRepository,
      'maxPullRequestsPerRepository',
      { maximum: 100 },
    ),
    mergeMethod: cleanString(merged.mergeMethod, 'mergeMethod'),
    allowedBaseBranches: uniqueStrings(merged.allowedBaseBranches, 'allowedBaseBranches'),
    requireOptInLabel: Boolean(merged.requireOptInLabel),
    optInLabels: uniqueStrings(merged.optInLabels, 'optInLabels', { lowerCase: true }),
    denyLabels: uniqueStrings(merged.denyLabels, 'denyLabels', { lowerCase: true }),
    requireHumanApproval: Boolean(merged.requireHumanApproval),
    ignoredCiContexts: uniqueStrings(merged.ignoredCiContexts, 'ignoredCiContexts'),
    repositoryDependencies: normalizeRepositoryDependencies(merged.repositoryDependencies),
  };
  if (!['merge', 'squash', 'rebase'].includes(policy.mergeMethod)) {
    throw new Error('mergeMethod must be merge, squash, or rebase');
  }
  if (policy.requireOptInLabel && policy.optInLabels.length === 0) {
    throw new Error('optInLabels must not be empty when requireOptInLabel is true');
  }
  const overlappingLabels = policy.optInLabels.filter((label) => policy.denyLabels.includes(label));
  if (overlappingLabels.length > 0) {
    throw new Error(`Merge reaper labels cannot be both opt-in and denied: ${overlappingLabels.join(', ')}`);
  }
  return Object.freeze(policy);
}

export function pullRequestKey(owner, repo, number) {
  const repository = normalizeRepository(`${owner}/${repo}`);
  return `${repository}#${positiveInteger(number, 'pull request number')}`;
}

export function parsePullRequestDependencies(body, { owner, repo }) {
  const text = String(body ?? '');
  const repository = normalizeRepository(`${owner}/${repo}`);
  const dependencies = new Set();
  for (const directive of text.matchAll(DEPENDENCY_DIRECTIVE)) {
    const value = directive[1];
    for (const match of value.matchAll(FULL_DEPENDENCY)) {
      dependencies.add(pullRequestKey(match[1], match[2], match[3]));
    }
    for (const match of value.matchAll(LOCAL_DEPENDENCY)) {
      dependencies.add(`${repository}#${positiveInteger(match[1], 'dependency pull request number')}`);
    }
  }
  return [...dependencies].sort();
}

function labelNames(pullRequest) {
  return (pullRequest?.labels ?? [])
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter(Boolean)
    .map((label) => String(label).toLowerCase());
}

function latestReviewStates(reviews) {
  const latest = new Map();
  for (const review of reviews ?? []) {
    const login = String(review?.user?.login ?? '').trim();
    if (!login || String(review?.state ?? '').toUpperCase() === 'PENDING') continue;
    const submittedAt = Date.parse(review?.submitted_at ?? '') || 0;
    const current = latest.get(login);
    if (!current || submittedAt > current.submittedAt || (submittedAt === current.submittedAt && Number(review.id) > current.id)) {
      latest.set(login, {
        id: Number(review.id) || 0,
        state: String(review.state ?? '').toUpperCase(),
        submittedAt,
        type: String(review?.user?.type ?? ''),
      });
    }
  }
  return [...latest.values()];
}

function checkState(check) {
  if (!check) return 'missing';
  if (check.status !== 'completed') return String(check.status ?? 'pending');
  return String(check.conclusion ?? 'failure');
}

function ageHours(createdAt, now) {
  const created = Date.parse(createdAt ?? '');
  const current = now instanceof Date ? now.getTime() : Date.parse(now ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(current) || current < created) return null;
  return (current - created) / 3_600_000;
}

export function evaluateMergeCandidate({
  pullRequest,
  policy,
  now = new Date(),
  gateCheck = null,
  expectedGateAppId,
  expectedGateExternalId,
  ciStates = [],
  reviews = [],
  unresolvedReviewThreads = null,
  dependencyStates = {},
}) {
  const normalizedPolicy = validateMergeReaperPolicy(policy);
  const reasons = [];
  const number = Number(pullRequest?.number);
  const owner = pullRequest?.base?.repo?.owner?.login
    ?? String(pullRequest?.base?.repo?.full_name ?? '').split('/')[0];
  const repo = pullRequest?.base?.repo?.name
    ?? String(pullRequest?.base?.repo?.full_name ?? '').split('/')[1];
  let key = null;
  try {
    key = pullRequestKey(owner, repo, number);
  } catch {
    reasons.push('invalid-pull-request-identity');
  }

  if (pullRequest?.state !== 'open') reasons.push('pull-request-not-open');
  if (pullRequest?.draft) reasons.push('draft-pull-request');
  if (pullRequest?.auto_merge) reasons.push('native-auto-merge-already-enabled');

  const age = ageHours(pullRequest?.created_at, now);
  if (age === null) reasons.push('invalid-created-at');
  else if (age < normalizedPolicy.minimumAgeHours) reasons.push('younger-than-minimum-age');

  const baseBranch = String(pullRequest?.base?.ref ?? '');
  if (!normalizedPolicy.allowedBaseBranches.includes(baseBranch)) reasons.push('base-branch-not-allowed');
  if (pullRequest?.mergeable !== true) reasons.push(pullRequest?.mergeable === null ? 'mergeability-unknown' : 'not-mergeable');
  if (String(pullRequest?.mergeable_state ?? '') !== 'clean') reasons.push('mergeable-state-not-clean');

  const labels = labelNames(pullRequest);
  const denied = normalizedPolicy.denyLabels.filter((label) => labels.includes(label));
  if (denied.length > 0) reasons.push(`denied-label:${denied.join(',')}`);
  if (normalizedPolicy.requireOptInLabel && !normalizedPolicy.optInLabels.some((label) => labels.includes(label))) {
    reasons.push('missing-automerge-opt-in-label');
  }

  const gateAppId = Number(expectedGateAppId);
  if (!Number.isSafeInteger(gateAppId) || gateAppId < 1) reasons.push('invalid-expected-gate-app-id');
  if (!gateCheck) reasons.push('missing-ores-gate');
  else {
    if (gateCheck.name !== 'ores-review/gate') reasons.push('unexpected-gate-context');
    if (Number(gateCheck?.app?.id) !== gateAppId) reasons.push('gate-app-identity-mismatch');
    if (gateCheck.external_id !== expectedGateExternalId) reasons.push('gate-external-id-mismatch');
    if (gateCheck.head_sha && gateCheck.head_sha !== pullRequest?.head?.sha) reasons.push('gate-head-sha-mismatch');
    if (checkState(gateCheck) !== 'success') reasons.push(`gate-not-success:${checkState(gateCheck)}`);
  }

  const ignoredContexts = new Set(normalizedPolicy.ignoredCiContexts);
  const effectiveCiStates = (ciStates ?? []).filter((item) => !ignoredContexts.has(item.context));
  if (effectiveCiStates.length === 0) reasons.push('no-independent-ci-contexts');
  for (const ci of effectiveCiStates) {
    if (ci.state !== 'success') reasons.push(`ci-not-success:${ci.context}:${ci.state}`);
  }

  const reviewStates = latestReviewStates(reviews);
  if (reviewStates.some((review) => review.state === 'CHANGES_REQUESTED')) reasons.push('changes-requested');
  if (normalizedPolicy.requireHumanApproval
    && !reviewStates.some((review) => review.state === 'APPROVED' && review.type !== 'Bot')) {
    reasons.push('missing-human-approval');
  }

  if (!Number.isSafeInteger(unresolvedReviewThreads) || unresolvedReviewThreads < 0) {
    reasons.push('review-thread-state-unavailable');
  } else if (unresolvedReviewThreads > 0) {
    reasons.push(`unresolved-review-threads:${unresolvedReviewThreads}`);
  }

  for (const [dependency, state] of Object.entries(dependencyStates ?? {})) {
    if (!['merged', 'eligible-earlier'].includes(state)) reasons.push(`dependency-not-ready:${dependency}:${state}`);
  }

  return Object.freeze({
    key,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    ageHours: age,
    labels: Object.freeze(labels),
  });
}

export function topologicallyOrderRepositories(repositories, repositoryDependencies = {}) {
  const normalizedRepositories = [...new Set(repositories.map((repository) => normalizeRepository(repository)))];
  const nodes = new Set(normalizedRepositories);
  for (const [repository, dependencies] of Object.entries(repositoryDependencies ?? {})) {
    const normalizedRepository = normalizeRepository(repository);
    nodes.add(normalizedRepository);
    for (const dependency of dependencies ?? []) nodes.add(normalizeRepository(dependency));
  }

  const indegree = new Map([...nodes].map((node) => [node, 0]));
  const dependents = new Map([...nodes].map((node) => [node, new Set()]));
  for (const [repository, dependencies] of Object.entries(repositoryDependencies ?? {})) {
    const normalizedRepository = normalizeRepository(repository);
    for (const dependency of dependencies ?? []) {
      const normalizedDependency = normalizeRepository(dependency);
      if (!dependents.get(normalizedDependency).has(normalizedRepository)) {
        dependents.get(normalizedDependency).add(normalizedRepository);
        indegree.set(normalizedRepository, indegree.get(normalizedRepository) + 1);
      }
    }
  }

  const ready = [...nodes].filter((node) => indegree.get(node) === 0).sort();
  const ordered = [];
  while (ready.length > 0) {
    const node = ready.shift();
    ordered.push(node);
    for (const dependent of [...dependents.get(node)].sort()) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== nodes.size) {
    const cyclic = [...nodes].filter((node) => indegree.get(node) > 0).sort();
    throw new Error(`Repository dependency cycle detected: ${cyclic.join(', ')}`);
  }
  const requested = new Set(normalizedRepositories);
  return ordered.filter((repository) => requested.has(repository));
}

export function orderMergeCandidates(candidates, repositoryDependencies = {}) {
  const byKey = new Map();
  for (const candidate of candidates) {
    if (!candidate?.key || byKey.has(candidate.key)) throw new Error('Merge candidates require unique keys');
    byKey.set(candidate.key, candidate);
  }

  const indegree = new Map([...byKey.keys()].map((key) => [key, 0]));
  const dependents = new Map([...byKey.keys()].map((key) => [key, new Set()]));
  function addEdge(dependencyKey, dependentKey) {
    if (!byKey.has(dependencyKey) || !byKey.has(dependentKey) || dependencyKey === dependentKey) return;
    if (dependents.get(dependencyKey).has(dependentKey)) return;
    dependents.get(dependencyKey).add(dependentKey);
    indegree.set(dependentKey, indegree.get(dependentKey) + 1);
  }

  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies ?? []) addEdge(dependency, candidate.key);
  }

  const candidatesByRepository = new Map();
  for (const candidate of candidates) {
    const repository = normalizeRepository(candidate.repository);
    if (!candidatesByRepository.has(repository)) candidatesByRepository.set(repository, []);
    candidatesByRepository.get(repository).push(candidate.key);
  }
  for (const [repository, dependencies] of Object.entries(repositoryDependencies ?? {})) {
    const dependentKeys = candidatesByRepository.get(normalizeRepository(repository)) ?? [];
    for (const dependencyRepository of dependencies ?? []) {
      const dependencyKeys = candidatesByRepository.get(normalizeRepository(dependencyRepository)) ?? [];
      for (const dependencyKey of dependencyKeys) {
        for (const dependentKey of dependentKeys) addEdge(dependencyKey, dependentKey);
      }
    }
  }

  const compare = (leftKey, rightKey) => {
    const left = byKey.get(leftKey);
    const right = byKey.get(rightKey);
    const leftCreated = Date.parse(left.createdAt ?? '') || 0;
    const rightCreated = Date.parse(right.createdAt ?? '') || 0;
    return leftCreated - rightCreated || leftKey.localeCompare(rightKey);
  };
  const ready = [...byKey.keys()].filter((key) => indegree.get(key) === 0).sort(compare);
  const ordered = [];
  while (ready.length > 0) {
    const key = ready.shift();
    ordered.push(byKey.get(key));
    for (const dependent of [...dependents.get(key)].sort(compare)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== candidates.length) {
    const cyclic = [...byKey.keys()].filter((key) => indegree.get(key) > 0).sort();
    throw new Error(`Pull-request dependency cycle detected: ${cyclic.join(', ')}`);
  }
  return ordered;
}

export function selectMergeBatch(candidates, maxMerges = 3) {
  const maximum = positiveInteger(maxMerges, 'maxMerges', { maximum: 3 });
  return candidates
    .filter((candidate) => candidate?.evaluation?.eligible === true || candidate?.eligible === true)
    .slice(0, maximum);
}
