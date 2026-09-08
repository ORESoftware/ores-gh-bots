import { parseReviewerHints } from './reviewer-hints.mjs';
import {
  addCandidate,
  apiPullRequestReference,
  boundedString,
  candidateKey,
  COUNTING_PERMISSIONS,
  MAX_QUEUE_ITEMS,
  normalizeReviewerLogin,
  positiveInteger,
  pullRequestReference,
  REVIEWER_QUEUE_SCHEMA,
  sameLogin,
  SHA,
} from './reviewer-validation.mjs';

const LIVE_FETCH_CONCURRENCY = 4;
const SOURCE_PRIORITY = Object.freeze({
  'review-requested': 0,
  assigned: 1,
  mentioned: 2,
});

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sourcePriority(reference) {
  let rank = 3;
  for (const source of reference.sources) rank = Math.min(rank, SOURCE_PRIORITY[source] ?? 3);
  return rank;
}

export async function assertReviewerIdentity(client, token, expectedLogin) {
  const reviewer = normalizeReviewerLogin(expectedLogin);
  boundedString(token, 'reviewer token', 16_384, true);
  const response = await client.request('GET', '/user', { token });
  const actual = normalizeReviewerLogin(response.data?.login);
  if (!sameLogin(actual, reviewer) || response.data?.type !== 'User') {
    throw new Error(`reviewer identity mismatch: expected ${reviewer}`);
  }
  return Object.freeze({ login: actual, id: Number(response.data?.id) || null, type: 'User' });
}

export async function listPullRequestReviews(client, token, owner, repo, prNumber) {
  return client.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews?per_page=100`, {
    token,
    maxPages: 10,
    map: (data) => Array.isArray(data) ? data : [],
  });
}

export async function getReviewerPermission(client, token, owner, repo, reviewer) {
  try {
    const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(reviewer)}/permission`, { token });
    return boundedString(response.data?.permission, 'collaborator permission', 32).toLowerCase() || 'none';
  } catch (error) {
    if (Number(error?.status) === 404) return 'none';
    throw error;
  }
}

export function pullRequestRequestsReviewer(pullRequest, reviewerLogin) {
  const reviewer = normalizeReviewerLogin(reviewerLogin);
  return Array.isArray(pullRequest?.requested_reviewers)
    && pullRequest.requested_reviewers.some((item) => sameLogin(item?.login, reviewer));
}

export function currentHeadReview(allReviews, reviewerLogin, headSha) {
  const reviewer = normalizeReviewerLogin(reviewerLogin);
  const sha = boundedString(headSha, 'pull request head SHA', 40, true).toLowerCase();
  if (!SHA.test(sha)) throw new Error('pull request head SHA is invalid');
  return (Array.isArray(allReviews) ? allReviews : [])
    .filter((review) => sameLogin(review?.user?.login, reviewer) && String(review?.commit_id ?? '').toLowerCase() === sha)
    // COMMENTED reviews are informational and must not hide an effective
    // approval or change request on the same head. Dismissal is decisive.
    .filter((review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review?.state))
    .sort((left, right) => timestamp(right?.submitted_at) - timestamp(left?.submitted_at)
      || Number(right?.id ?? 0) - Number(left?.id ?? 0))[0] ?? null;
}

function classify(reference, pullRequest, allReviews, collaboratorPermission, reviewer) {
  const current = currentHeadReview(allReviews, reviewer, pullRequest.head.sha);
  const requested = pullRequestRequestsReviewer(pullRequest, reviewer);
  const author = boundedString(pullRequest.user?.login, 'pull request author', 39) || null;
  let disposition = 'inspect';
  let reason = 'indirect-signal-only';
  if (pullRequest.state !== 'open') [disposition, reason] = ['ignore', `pull-request-${String(pullRequest.state ?? 'unknown')}`];
  else if (pullRequest.draft) [disposition, reason] = ['hold', 'draft-pull-request'];
  else if (author && sameLogin(author, reviewer)) [disposition, reason] = ['blocked', 'self-authored-pull-request'];
  else if (current?.state === 'APPROVED') [disposition, reason] = ['complete', 'approved-current-head'];
  else if (current?.state === 'CHANGES_REQUESTED') [disposition, reason] = ['complete', 'changes-requested-current-head'];
  else if (requested && COUNTING_PERMISSIONS.has(collaboratorPermission)) [disposition, reason] = ['review', 'explicit-live-review-request'];
  else if (requested) [disposition, reason] = ['blocked', 'reviewer-lacks-counting-permission'];
  return Object.freeze({
    repository: `${reference.owner}/${reference.repo}`,
    pr_number: pullRequest.number,
    title: boundedString(pullRequest.title, 'pull request title', 1_000),
    html_url: pullRequestReference(pullRequest.html_url) ? pullRequest.html_url : null,
    head_sha: pullRequest.head.sha,
    author,
    updated_at: pullRequest.updated_at ?? null,
    live_review_requested: requested,
    collaborator_permission: collaboratorPermission,
    current_head_review: current ? Object.freeze({ state: current.state, id: current.id ?? null }) : null,
    sources: Object.freeze([...reference.sources].sort()),
    hint_ids: Object.freeze([...reference.hintIds].sort()),
    disposition,
    reason,
  });
}

async function liveCandidate(client, token, reviewer, reference) {
  const path = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/pulls/${reference.prNumber}`;
  const response = await client.request('GET', path, { token });
  const pullRequest = response.data;
  if (!SHA.test(String(pullRequest?.head?.sha ?? '').toLowerCase())) throw new Error('live pull request returned an invalid head SHA');
  const [allReviews, collaboratorPermission] = await Promise.all([
    listPullRequestReviews(client, token, reference.owner, reference.repo, reference.prNumber),
    getReviewerPermission(client, token, reference.owner, reference.repo, reviewer),
  ]);
  return classify(reference, pullRequest, allReviews, collaboratorPermission, reviewer);
}

export async function buildReviewerQueue({ client, token, reviewerLogin = 'the1mills', hints = null, limit = MAX_QUEUE_ITEMS }) {
  const reviewer = normalizeReviewerLogin(reviewerLogin);
  const max = positiveInteger(limit, 'reviewer queue limit', MAX_QUEUE_ITEMS);
  const identity = await assertReviewerIdentity(client, token, reviewer);
  const references = new Map();
  for (const [source, query] of [
    ['review-requested', `is:pr is:open archived:false review-requested:${reviewer}`],
    ['assigned', `is:pr is:open archived:false assignee:${reviewer}`],
    ['mentioned', `is:pr is:open archived:false mentions:${reviewer}`],
  ]) {
    const items = await client.paginate(`/search/issues?q=${encodeURIComponent(query)}&per_page=100`, {
      token,
      maxPages: 1,
      map: (data) => Array.isArray(data?.items) ? data.items : [],
    });
    for (const item of items.slice(0, max)) {
      const reference = apiPullRequestReference(item, client.apiOrigin ?? 'https://api.github.com');
      if (reference) addCandidate(references, reference, source);
    }
  }
  for (const hint of parseReviewerHints(hints, reviewer)) {
    const id = candidateKey(hint.owner, hint.repo, hint.prNumber);
    const current = references.get(id) ?? { owner: hint.owner, repo: hint.repo, prNumber: hint.prNumber, sources: new Set(), hintIds: new Set() };
    for (const source of hint.sources) current.sources.add(source);
    for (const idValue of hint.hintIds) current.hintIds.add(idValue);
    references.set(id, current);
  }
  const selected = [...references.values()]
    // A bounded plan must never let an inbox hint or casual mention starve an
    // explicit GitHub review request.
    .sort((left, right) => sourcePriority(left) - sourcePriority(right)
      || candidateKey(left.owner, left.repo, left.prNumber).localeCompare(candidateKey(right.owner, right.repo, right.prNumber)))
    .slice(0, max);
  const candidates = await mapLimit(selected, LIVE_FETCH_CONCURRENCY, async (reference) => {
    try { return await liveCandidate(client, token, reviewer, reference); }
    catch (error) {
      return Object.freeze({
        repository: `${reference.owner}/${reference.repo}`,
        pr_number: reference.prNumber,
        sources: Object.freeze([...reference.sources].sort()),
        hint_ids: Object.freeze([...reference.hintIds].sort()),
        disposition: 'unavailable',
        reason: 'live-pull-request-unavailable',
        status: Number(error?.status) || null,
      });
    }
  });
  const rank = { review: 0, blocked: 1, inspect: 2, hold: 3, complete: 4, unavailable: 5, ignore: 6 };
  candidates.sort((left, right) => (rank[left.disposition] ?? 99) - (rank[right.disposition] ?? 99)
    || String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''))
    || `${left.repository}#${left.pr_number}`.localeCompare(`${right.repository}#${right.pr_number}`));
  return Object.freeze({
    schema: REVIEWER_QUEUE_SCHEMA,
    reviewer: identity,
    count: candidates.length,
    review_count: candidates.filter((candidate) => candidate.disposition === 'review').length,
    candidates: Object.freeze(candidates),
  });
}

export async function findSuccessfulGateCheck({ client, token, owner, repo, prNumber, headSha, gateAppId }) {
  const safeOwner = repositoryPart(owner, 'repository owner');
  const safeRepo = repositoryPart(repo, 'repository name');
  const number = positiveInteger(prNumber, 'pull request number', 2_147_483_647);
  const sha = boundedString(headSha, 'pull request head SHA', 40, true).toLowerCase();
  if (!SHA.test(sha)) throw new Error('pull request head SHA is invalid');
  const appId = positiveInteger(gateAppId, 'Gate App ID');
  const externalId = `gate:${safeOwner}/${safeRepo}#${number}@${sha}`;
  const response = await client.request('GET', `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/commits/${sha}/check-runs?check_name=${encodeURIComponent('ores-review/gate')}&filter=latest&per_page=100`, { token });
  return (Array.isArray(response.data?.check_runs) ? response.data.check_runs : [])
    .filter((check) => check?.name === 'ores-review/gate'
      && String(check?.head_sha ?? '').toLowerCase() === sha
      && Number(check?.app?.id) === appId
      && check?.external_id === externalId
      && check?.status === 'completed'
      && check?.conclusion === 'success')
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0))[0] ?? null;
}
