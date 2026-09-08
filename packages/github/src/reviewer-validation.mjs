export const REVIEWER_HINTS_SCHEMA = 'ores.gh-bots.reviewer-hints/v1';
export const REVIEWER_QUEUE_SCHEMA = 'ores.gh-bots.reviewer-queue/v1';
export const REVIEWER_HINTS_MAX_BYTES = 262_144;
export const MAX_QUEUE_ITEMS = 100;
export const COUNTING_PERMISSIONS = new Set(['write', 'maintain', 'admin']);
export const SHA = /^[a-f0-9]{40}$/u;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/u;

export function boundedString(value, label, max, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${label} is required`);
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return result;
}

export function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) {
    throw new Error(`${label} must be a positive integer no greater than ${max}`);
  }
  return result;
}

export function sameLogin(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

export function plainObject(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
  return value;
}

export function normalizeReviewerLogin(value) {
  const result = boundedString(value, 'reviewer login', 39, true);
  if (!LOGIN.test(result) || result.endsWith('-') || result.includes('--')) throw new Error('reviewer login is invalid');
  return result;
}

export function repositoryPart(value, label) {
  const result = boundedString(value, label, 100, true);
  if (!REPO_PART.test(result) || result === '.' || result === '..') throw new Error(`${label} is invalid`);
  return result;
}

export function candidateKey(owner, repo, prNumber) {
  return `${owner}/${repo}#${prNumber}`.toLowerCase();
}

export function pullRequestReference(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[2] !== 'pull' || !/^\d{1,10}$/u.test(parts[3])) return null;
  try {
    return {
      owner: repositoryPart(parts[0], 'repository owner'),
      repo: repositoryPart(parts[1], 'repository name'),
      prNumber: positiveInteger(parts[3], 'pull request number', 2_147_483_647),
    };
  } catch { return null; }
}

export function apiPullRequestReference(item, apiOrigin) {
  let url;
  try { url = new URL(String(item?.repository_url)); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== apiOrigin || !item?.pull_request) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'repos') return null;
  try {
    return {
      owner: repositoryPart(parts[1], 'repository owner'),
      repo: repositoryPart(parts[2], 'repository name'),
      prNumber: positiveInteger(item.number, 'pull request number', 2_147_483_647),
    };
  } catch { return null; }
}

export function addCandidate(map, reference, source, hintId = null) {
  const id = candidateKey(reference.owner, reference.repo, reference.prNumber);
  const current = map.get(id) ?? { ...reference, sources: new Set(), hintIds: new Set() };
  current.sources.add(source);
  if (hintId) current.hintIds.add(hintId);
  map.set(id, current);
}
