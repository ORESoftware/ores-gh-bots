import { createCheckRun, updateCheckRun } from './checks.mjs';
import { createPullRequestReview } from './pull-requests.mjs';
import { parseReviewPublicationMarkers } from '../../core/src/review-attempt.mjs';

function providerCheckPayload({ name, headSha, detailsUrl, externalId, summary }) {
  return {
    name,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    details_url: detailsUrl || undefined,
    external_id: externalId,
    output: {
      title: name,
      summary: String(summary ?? '').slice(0, 65_535),
    },
  };
}

async function listProviderAttemptChecks({ client, token, owner, repo, headSha, name, externalId, appId }) {
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=all&per_page=100`,
    { token },
  );
  const all = response.data?.check_runs ?? [];
  return all.filter((check) => (
    check?.name === name
    && String(check?.head_sha ?? '').toLowerCase() === String(headSha).toLowerCase()
    && check?.external_id === externalId
    && Number(check?.app?.id) === Number(appId)
  ));
}

function exactlyOneOrNone(matches, label) {
  if (matches.length > 1) {
    throw new Error(`${label} has ${matches.length} exact trusted matches; refusing ambiguous reuse`);
  }
  return matches[0] ?? null;
}

export async function ensureProviderAttemptCheck({
  client,
  token,
  owner,
  repo,
  headSha,
  name,
  detailsUrl,
  externalId,
  summary,
  appId,
}) {
  const existing = exactlyOneOrNone(
    await listProviderAttemptChecks({ client, token, owner, repo, headSha, name, externalId, appId }),
    `${name} ${externalId}`,
  );
  if (existing) {
    if (existing.status === 'completed') return { ...existing, reused: true };
    const payload = providerCheckPayload({ name, headSha, detailsUrl, externalId, summary });
    const { head_sha: _headSha, ...updatePayload } = payload;
    return { ...(await updateCheckRun(client, token, owner, repo, existing.id, updatePayload)), reused: true };
  }

  const created = await createCheckRun(
    client,
    token,
    owner,
    repo,
    providerCheckPayload({ name, headSha, detailsUrl, externalId, summary }),
  );
  const after = exactlyOneOrNone(
    await listProviderAttemptChecks({ client, token, owner, repo, headSha, name, externalId, appId }),
    `${name} ${externalId}`,
  );
  if (!after || Number(after.id) !== Number(created.id)) {
    throw new Error(`${name} exact trusted Check Run could not be uniquely re-discovered after creation`);
  }
  return { ...after, reused: false };
}

async function listPullRequestReviews(client, token, owner, repo, prNumber) {
  return client.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews?per_page=100`, {
    token,
    map: (data) => data,
  });
}

function reviewPublicationMatches(reviews, publicationId) {
  return reviews.filter((review) => parseReviewPublicationMarkers(review?.body)
    .some((marker) => marker.id === publicationId));
}

function exactPublicationReview(matches, { body, headSha, publicationId }) {
  if (matches.length > 1) {
    throw new Error(`attestation publication ${publicationId} has ${matches.length} reviews; refusing ambiguous reuse`);
  }
  if (matches.length === 0) return null;
  const review = matches[0];
  const markers = parseReviewPublicationMarkers(review.body)
    .filter((marker) => marker.id === publicationId);
  if (
    markers.length !== 1
    || markers[0].headSha !== headSha
    || String(review.commit_id ?? '').toLowerCase() !== String(headSha).toLowerCase()
    || String(review.body ?? '') !== String(body)
  ) {
    throw new Error(`attestation publication ${publicationId} collides with non-identical review evidence`);
  }
  return review;
}

export async function ensurePullRequestReviewPublication({
  client,
  token,
  owner,
  repo,
  prNumber,
  headSha,
  publicationId,
  body,
  event = 'COMMENT',
}) {
  const before = exactPublicationReview(
    reviewPublicationMatches(await listPullRequestReviews(client, token, owner, repo, prNumber), publicationId),
    { body, headSha, publicationId },
  );
  if (before) return { review: before, reused: true };

  const created = await createPullRequestReview(client, token, owner, repo, prNumber, {
    body,
    event,
    commitId: headSha,
  });
  const after = exactPublicationReview(
    reviewPublicationMatches(await listPullRequestReviews(client, token, owner, repo, prNumber), publicationId),
    { body, headSha, publicationId },
  );
  if (!after || Number(after.id) !== Number(created.id)) {
    throw new Error(`attestation publication ${publicationId} could not be uniquely re-discovered after creation`);
  }
  return { review: after, reused: false };
}
