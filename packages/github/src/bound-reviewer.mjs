import {
  createPullRequestReview,
  getCollaboratorPermission,
  getPullRequest,
} from './pull-requests.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/u;
const COUNTING_PERMISSIONS = new Set(['write', 'maintain', 'admin']);

function boundedString(value, label, max, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${label} must be a positive integer no greater than ${max}`);
  }
  return number;
}

function repositoryPart(value, label) {
  const text = boundedString(value, label, 100, true);
  if (!REPO_PART.test(text) || text === '.' || text === '..') {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function reviewerLogin(value) {
  const text = boundedString(value, 'reviewer login', 39, true);
  if (!LOGIN.test(text) || text.endsWith('-') || text.includes('--')) {
    throw new Error('reviewer login is invalid');
  }
  return text;
}

function sameLogin(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
}

function normalizeHeadSha(value, label = 'expected head SHA') {
  const sha = boundedString(value, label, 40, true).toLowerCase();
  if (!SHA.test(sha)) throw new Error(`${label} is invalid`);
  return sha;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function assertBoundReviewerIdentity(client, token, expectedLogin = 'the1mills') {
  const reviewer = reviewerLogin(expectedLogin);
  boundedString(token, 'reviewer token', 16_384, true);
  const response = await client.request('GET', '/user', { token });
  const actual = reviewerLogin(response.data?.login);
  if (!sameLogin(actual, reviewer) || response.data?.type !== 'User') {
    throw new Error(`reviewer identity mismatch: expected ${reviewer}`);
  }
  return Object.freeze({
    login: actual,
    id: Number(response.data?.id) || null,
    type: 'User',
  });
}

export async function listBoundReviewerPullRequestReviews(client, token, owner, repo, prNumber) {
  const safeOwner = repositoryPart(owner, 'repository owner');
  const safeRepo = repositoryPart(repo, 'repository name');
  const number = positiveInteger(prNumber, 'pull request number', 2_147_483_647);
  return client.paginate(
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls/${number}/reviews?per_page=100`,
    {
      token,
      maxPages: 10,
      map: (data) => (Array.isArray(data) ? data : []),
    },
  );
}

export function currentBoundReviewerHeadReview(allReviews, expectedLogin, headSha) {
  const reviewer = reviewerLogin(expectedLogin);
  const sha = normalizeHeadSha(headSha, 'pull request head SHA');
  return (Array.isArray(allReviews) ? allReviews : [])
    .filter((review) => sameLogin(review?.user?.login, reviewer))
    .filter((review) => String(review?.commit_id ?? '').toLowerCase() === sha)
    .filter((review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review?.state))
    .sort((left, right) => (
      timestamp(right?.submitted_at) - timestamp(left?.submitted_at)
      || Number(right?.id ?? 0) - Number(left?.id ?? 0)
    ))[0] ?? null;
}

function requestsReviewer(pullRequest, expectedLogin) {
  const reviewer = reviewerLogin(expectedLogin);
  return Array.isArray(pullRequest?.requested_reviewers)
    && pullRequest.requested_reviewers.some((item) => sameLogin(item?.login, reviewer));
}

function validatePullRequest(pullRequest, reviewer, headSha, requireRequested) {
  if (pullRequest?.state !== 'open') throw new Error('pull request is not open');
  if (pullRequest?.draft) throw new Error('pull request is draft');
  if (String(pullRequest?.head?.sha ?? '').toLowerCase() !== headSha) {
    throw new Error('pull request head moved');
  }
  if (sameLogin(pullRequest?.user?.login, reviewer)) {
    throw new Error('reviewer cannot review a self-authored pull request');
  }
  if (requireRequested && !requestsReviewer(pullRequest, reviewer)) {
    throw new Error('reviewer is no longer requested on the pull request');
  }
}

function existingReviewResult(review, headSha) {
  if (review?.state === 'APPROVED') {
    return Object.freeze({
      status: 'already-submitted',
      review_id: review.id ?? null,
      head_sha: headSha,
    });
  }
  if (review?.state === 'CHANGES_REQUESTED') {
    throw new Error('reviewer has requested changes on the current pull request head');
  }
  return null;
}

function requireCountingPermission(permission) {
  const normalized = String(permission ?? '').toLowerCase();
  if (!COUNTING_PERMISSIONS.has(normalized)) {
    throw new Error('reviewer lacks write-or-stronger permission required for a counting review');
  }
  return normalized;
}

async function reviewerPermission(client, token, owner, repo, reviewer) {
  try {
    return await getCollaboratorPermission(client, token, owner, repo, reviewer);
  } catch (error) {
    if (Number(error?.status ?? error?.response?.status ?? 0) === 404) return 'none';
    throw error;
  }
}

export async function findSuccessfulBoundReviewerGate({
  client,
  token,
  owner,
  repo,
  prNumber,
  headSha,
  gateAppId,
}) {
  const safeOwner = repositoryPart(owner, 'repository owner');
  const safeRepo = repositoryPart(repo, 'repository name');
  const number = positiveInteger(prNumber, 'pull request number', 2_147_483_647);
  const sha = normalizeHeadSha(headSha, 'pull request head SHA');
  const appId = positiveInteger(gateAppId, 'Gate App ID');
  const externalId = `gate:${safeOwner}/${safeRepo}#${number}@${sha}`;
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/commits/${sha}/check-runs?check_name=${encodeURIComponent('ores-review/gate')}&filter=latest&per_page=100`,
    { token },
  );
  return (Array.isArray(response.data?.check_runs) ? response.data.check_runs : [])
    .filter((check) => (
      check?.name === 'ores-review/gate'
      && String(check?.head_sha ?? '').toLowerCase() === sha
      && Number(check?.app?.id) === appId
      && check?.external_id === externalId
      && check?.status === 'completed'
      && check?.conclusion === 'success'
    ))
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0))[0] ?? null;
}

async function verifyGateCheckRun(client, token, {
  owner,
  repo,
  prNumber,
  headSha,
  gateCheckRunId,
  gateAppId,
}) {
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${gateCheckRunId}`,
    { token },
  );
  const check = response.data;
  if (
    Number(check?.id) !== gateCheckRunId
    || check?.name !== 'ores-review/gate'
    || String(check?.head_sha ?? '').toLowerCase() !== headSha
    || Number(check?.app?.id) !== gateAppId
    || check?.external_id !== `gate:${owner}/${repo}#${prNumber}@${headSha}`
    || check?.status !== 'completed'
    || check?.conclusion !== 'success'
  ) {
    throw new Error('aggregate gate evidence is not an exact-head success from the configured Gate App');
  }
  return check;
}

export async function submitBoundReviewerApproval({
  client,
  token,
  reviewerLogin: expectedLogin = 'the1mills',
  owner,
  repo,
  prNumber,
  expectedHeadSha,
  body,
  gateCheckRunId,
  gateAppId,
}) {
  const safeReviewer = reviewerLogin(expectedLogin);
  const safeOwner = repositoryPart(owner, 'repository owner');
  const safeRepo = repositoryPart(repo, 'repository name');
  const number = positiveInteger(prNumber, 'pull request number', 2_147_483_647);
  const headSha = normalizeHeadSha(expectedHeadSha);
  const runId = positiveInteger(gateCheckRunId, 'gate check run ID');
  const appId = positiveInteger(gateAppId, 'Gate App ID');
  const summary = boundedString(body, 'review body', 60_000, true);

  const identity = await assertBoundReviewerIdentity(client, token, safeReviewer);
  const initial = await getPullRequest(client, token, safeOwner, safeRepo, number);
  validatePullRequest(initial, identity.login, headSha, false);

  const [initialReviews, initialPermission] = await Promise.all([
    listBoundReviewerPullRequestReviews(client, token, safeOwner, safeRepo, number),
    reviewerPermission(client, token, safeOwner, safeRepo, identity.login),
  ]);
  const existing = existingReviewResult(
    currentBoundReviewerHeadReview(initialReviews, identity.login, headSha),
    headSha,
  );
  if (existing) return existing;
  if (!requestsReviewer(initial, identity.login)) {
    throw new Error('reviewer is no longer requested on the pull request');
  }
  requireCountingPermission(initialPermission);

  await verifyGateCheckRun(client, token, {
    owner: safeOwner,
    repo: safeRepo,
    prNumber: number,
    headSha,
    gateCheckRunId: runId,
    gateAppId: appId,
  });

  // Re-read every mutable authorization input immediately before mutation.
  const [latest, latestReviews, latestPermission] = await Promise.all([
    getPullRequest(client, token, safeOwner, safeRepo, number),
    listBoundReviewerPullRequestReviews(client, token, safeOwner, safeRepo, number),
    reviewerPermission(client, token, safeOwner, safeRepo, identity.login),
  ]);
  validatePullRequest(latest, identity.login, headSha, true);
  const latestExisting = existingReviewResult(
    currentBoundReviewerHeadReview(latestReviews, identity.login, headSha),
    headSha,
  );
  if (latestExisting) return latestExisting;
  requireCountingPermission(latestPermission);

  const reviewBody = `${summary}\n\n---\nAutomated review submitted by ORES GitHub Bots for @${identity.login}. `
    + `Bound to exact head \`${headSha}\` and successful aggregate gate check run \`${runId}\`.`;
  const review = await createPullRequestReview(
    client,
    token,
    safeOwner,
    safeRepo,
    number,
    { body: reviewBody, event: 'APPROVE', commitId: headSha },
  );

  const after = await getPullRequest(client, token, safeOwner, safeRepo, number);
  return Object.freeze({
    status: String(after?.head?.sha ?? '').toLowerCase() === headSha
      ? 'submitted'
      : 'submitted-to-stale-head',
    review_id: review?.id ?? null,
    head_sha: headSha,
  });
}
