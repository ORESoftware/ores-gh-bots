import {
  assertReviewerIdentity,
  currentHeadReview,
  getReviewerPermission,
  listPullRequestReviews,
  pullRequestRequestsReviewer,
} from './reviewer-queue.mjs';
import {
  boundedString,
  COUNTING_PERMISSIONS,
  normalizeReviewerLogin,
  positiveInteger,
  repositoryPart,
  sameLogin,
  SHA,
} from './reviewer-validation.mjs';

async function getPullRequest(client, token, owner, repo, prNumber) {
  return (await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, { token })).data;
}

function validatePullRequest(pullRequest, reviewer, headSha, requireRequested) {
  if (pullRequest?.state !== 'open') throw new Error('pull request is not open');
  if (pullRequest?.draft) throw new Error('pull request is draft');
  if (String(pullRequest?.head?.sha ?? '').toLowerCase() !== headSha) throw new Error('pull request head moved');
  if (sameLogin(pullRequest?.user?.login, reviewer)) throw new Error('reviewer cannot review a self-authored pull request');
  if (requireRequested && !pullRequestRequestsReviewer(pullRequest, reviewer)) throw new Error('reviewer is no longer requested on the pull request');
}

function existingReviewResult(review, headSha) {
  if (review?.state === 'APPROVED') {
    return Object.freeze({ status: 'already-submitted', review_id: review.id ?? null, head_sha: headSha });
  }
  if (review?.state === 'CHANGES_REQUESTED') {
    throw new Error('reviewer has requested changes on the current pull request head');
  }
  return null;
}

function requireCountingPermission(permission) {
  if (!COUNTING_PERMISSIONS.has(permission)) {
    throw new Error('reviewer lacks write-or-stronger permission required for a counting review');
  }
}

async function verifyGate(client, token, owner, repo, prNumber, headSha, gateCheckRunId, gateAppId) {
  const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${gateCheckRunId}`, { token });
  const check = response.data;
  if (Number(check?.id) !== gateCheckRunId
    || check?.name !== 'ores-review/gate'
    || String(check?.head_sha ?? '').toLowerCase() !== headSha
    || Number(check?.app?.id) !== gateAppId
    || check?.external_id !== `gate:${owner}/${repo}#${prNumber}@${headSha}`
    || check?.status !== 'completed'
    || check?.conclusion !== 'success') {
    throw new Error('aggregate gate evidence is not an exact-head success from the configured Gate App');
  }
}

export async function submitBoundReviewerApproval({
  client,
  token,
  reviewerLogin = 'the1mills',
  owner,
  repo,
  prNumber,
  expectedHeadSha,
  body,
  gateCheckRunId,
  gateAppId,
}) {
  const reviewer = normalizeReviewerLogin(reviewerLogin);
  const safeOwner = repositoryPart(owner, 'repository owner');
  const safeRepo = repositoryPart(repo, 'repository name');
  const number = positiveInteger(prNumber, 'pull request number', 2_147_483_647);
  const headSha = boundedString(expectedHeadSha, 'expected head SHA', 40, true).toLowerCase();
  if (!SHA.test(headSha)) throw new Error('expected head SHA is invalid');
  const runId = positiveInteger(gateCheckRunId, 'gate check run ID');
  const appId = positiveInteger(gateAppId, 'Gate App ID');
  const summary = boundedString(body, 'review body', 60_000, true);
  const identity = await assertReviewerIdentity(client, token, reviewer);
  const initial = await getPullRequest(client, token, safeOwner, safeRepo, number);
  validatePullRequest(initial, identity.login, headSha, false);
  const [allReviews, collaboratorPermission] = await Promise.all([
    listPullRequestReviews(client, token, safeOwner, safeRepo, number),
    getReviewerPermission(client, token, safeOwner, safeRepo, identity.login),
  ]);
  const current = currentHeadReview(allReviews, identity.login, headSha);
  const existing = existingReviewResult(current, headSha);
  if (existing) return existing;
  if (!pullRequestRequestsReviewer(initial, identity.login)) throw new Error('reviewer is no longer requested on the pull request');
  requireCountingPermission(collaboratorPermission);
  await verifyGate(client, token, safeOwner, safeRepo, number, headSha, runId, appId);

  // Re-read every mutable authorization input immediately before the POST.
  // This prevents the automation from overwriting a manual change request or
  // relying on a reviewer request/permission that changed while gate evidence
  // was being verified.
  const [latest, latestReviews, latestPermission] = await Promise.all([
    getPullRequest(client, token, safeOwner, safeRepo, number),
    listPullRequestReviews(client, token, safeOwner, safeRepo, number),
    getReviewerPermission(client, token, safeOwner, safeRepo, identity.login),
  ]);
  validatePullRequest(latest, identity.login, headSha, true);
  const latestExisting = existingReviewResult(currentHeadReview(latestReviews, identity.login, headSha), headSha);
  if (latestExisting) return latestExisting;
  requireCountingPermission(latestPermission);

  const reviewBody = `${summary}\n\n---\nAutomated review submitted by ORES GitHub Bots for @${identity.login}. `
    + `Bound to exact head \`${headSha}\` and successful aggregate gate check run \`${runId}\`.`;
  const response = await client.request('POST', `/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/pulls/${number}/reviews`, {
    token,
    body: { body: reviewBody, event: 'APPROVE', commit_id: headSha },
  });
  const after = await getPullRequest(client, token, safeOwner, safeRepo, number);
  return Object.freeze({
    status: String(after?.head?.sha ?? '').toLowerCase() === headSha ? 'submitted' : 'submitted-to-stale-head',
    review_id: response.data?.id ?? null,
    head_sha: headSha,
  });
}
