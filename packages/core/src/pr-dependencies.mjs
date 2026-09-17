const DIRECTIVE = /^\s*(?:(?:[-*+]\s+)(?:\[[ xX]\]\s+)?)?(?:depends\s+on|depends-on|dependency|requires|merge-after|stacked-on)\s*:?[ \t]+(.+?)\s*$/iu;
const FULL_TARGET = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/pull\/|#)([1-9]\d*)(?:\s*@\s*([^\s,]+))?$/iu;
const LOCAL_TARGET = /^#([1-9]\d*)(?:\s*@\s*([^\s,]+))?$/u;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/u;
const FENCE = /^\s*(`{3,}|~{3,})/u;
const INDENTED_CODE = /^(?: {4,}|\t)/u;

function normalizeRepositoryPart(value, field) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+$/u.test(text)) throw new Error(`${field} is invalid`);
  return text.toLowerCase();
}

export function normalizeDependencyVersion(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!VERSION.test(text)) throw new Error(`Invalid dependency version: ${text}`);
  return /^v(?=\d)/iu.test(text) ? text.slice(1) : text;
}

export function pullRequestDependencyKey(owner, repo, prNumber) {
  const normalizedOwner = normalizeRepositoryPart(owner, 'dependency owner');
  const normalizedRepo = normalizeRepositoryPart(repo, 'dependency repository');
  const number = Number(prNumber);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('dependency pull request number is invalid');
  return `${normalizedOwner}/${normalizedRepo}#${number}`;
}

function parseDependencyTarget(value, current) {
  const cleaned = String(value ?? '').trim().replace(/[.;]$/u, '').trim();
  const full = FULL_TARGET.exec(cleaned);
  if (full) {
    const owner = normalizeRepositoryPart(full[1], 'dependency owner');
    const repo = normalizeRepositoryPart(full[2], 'dependency repository');
    const prNumber = Number(full[3]);
    const expectedVersion = normalizeDependencyVersion(full[4]);
    return Object.freeze({
      owner,
      repo,
      prNumber,
      expectedVersion,
      key: pullRequestDependencyKey(owner, repo, prNumber),
    });
  }

  const local = LOCAL_TARGET.exec(cleaned);
  if (!local) throw new Error(`Invalid PR dependency declaration: ${cleaned}`);
  const prNumber = Number(local[1]);
  const expectedVersion = normalizeDependencyVersion(local[2]);
  return Object.freeze({
    owner: current.owner,
    repo: current.repo,
    prNumber,
    expectedVersion,
    key: pullRequestDependencyKey(current.owner, current.repo, prNumber),
  });
}

function dependencyDirectiveValues(body) {
  const values = [];
  let fence = null;
  let htmlComment = false;

  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (fence === null) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    if (htmlComment) {
      if (line.includes('-->')) htmlComment = false;
      continue;
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->') || line.indexOf('<!--') > line.indexOf('-->')) htmlComment = true;
      continue;
    }
    if (INDENTED_CODE.test(line)) continue;

    const value = DIRECTIVE.exec(line)?.[1] ?? null;
    if (value !== null) values.push(value);
  }
  return values;
}

export function parsePullRequestDependencies(body, { owner, repo, maxDependencies = 32 } = {}) {
  const current = {
    owner: normalizeRepositoryPart(owner, 'current owner'),
    repo: normalizeRepositoryPart(repo, 'current repository'),
  };
  const maximum = Number(maxDependencies);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) {
    throw new Error('maxDependencies must be an integer between 1 and 128');
  }

  const declarations = dependencyDirectiveValues(body).map((value) => parseDependencyTarget(value, current));
  if (declarations.length > maximum) throw new Error(`PR declares more than ${maximum} dependencies`);

  const byKey = declarations.reduce((map, declaration) => {
    const existing = map.get(declaration.key);
    if (existing && existing.expectedVersion !== declaration.expectedVersion) {
      throw new Error(`Conflicting version requirements for ${declaration.key}`);
    }
    return existing ? map : new Map([...map, [declaration.key, declaration]]);
  }, new Map());

  return Object.freeze([...byKey.values()].sort((left, right) => left.key.localeCompare(right.key)));
}

export function normalizeDependencyGateStates(states) {
  if (!Array.isArray(states)) {
    return [Object.freeze({ dependency: null, state: 'failure', reason: 'dependency evidence is invalid' })];
  }
  return states.map((item) => {
    const state = ['success', 'pending', 'failure'].includes(item?.state) ? item.state : 'failure';
    const dependency = typeof item?.dependency === 'string' ? item.dependency : null;
    const reason = typeof item?.reason === 'string' && item.reason ? item.reason : 'dependency evidence is invalid';
    return Object.freeze({ ...item, dependency, state, reason });
  });
}
