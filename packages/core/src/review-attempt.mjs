import { createHash } from 'node:crypto';

const HEAD_SHA = /^[0-9a-f]{40}$/u;
const PROVIDER = /^(?:openai|claude)$/u;
const ATTEMPT_ID = /^[0-9a-f]{32}$/u;
const PUBLICATION_MARKER = /<!-- ores-review-publication v1 id=([0-9a-f]{32}) head=([0-9a-f]{40}) -->/gu;

function bounded(value, label, maximum = 512) {
  const text = String(value ?? '');
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} is missing, oversized, or contains control characters`);
  }
  return text;
}

function logicalAttempt(job) {
  if (job?.attemptId) return bounded(job.attemptId, 'review attempt id', 256);
  if (job?.dedupeKey) return bounded(job.dedupeKey, 'review dedupe key', 512);
  if (Number.isSafeInteger(job?.id) && Number(job.id) >= 0) return `job:${job.id}`;
  throw new Error('Review job has no durable logical attempt identity');
}

function reviewIdentity({ job, provider, headSha }) {
  const owner = bounded(job?.owner, 'review owner', 100).toLowerCase();
  const repo = bounded(job?.repo, 'review repository', 100).toLowerCase();
  const prNumber = Number(job?.prNumber);
  const normalizedProvider = String(provider ?? '').toLowerCase();
  const head = String(headSha ?? '').toLowerCase();
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('Review PR number must be positive');
  if (!PROVIDER.test(normalizedProvider)) throw new Error(`Unsupported review provider: ${provider}`);
  if (!HEAD_SHA.test(head)) throw new Error('Review head must be a lowercase 40-hex SHA');
  return { owner, repo, prNumber, provider: normalizedProvider, head, attempt: logicalAttempt(job) };
}

export function providerReviewAttemptId({ job, provider, headSha }) {
  const identity = reviewIdentity({ job, provider, headSha });
  return createHash('sha256')
    .update('ores-provider-review-attempt-v1\0')
    .update(identity.owner).update('\0')
    .update(identity.repo).update('\0')
    .update(String(identity.prNumber)).update('\0')
    .update(identity.head).update('\0')
    .update(identity.provider).update('\0')
    .update(identity.attempt)
    .digest('hex')
    .slice(0, 32);
}

export function providerReviewExternalId({ job, provider, headSha }) {
  const identity = reviewIdentity({ job, provider, headSha });
  const attemptId = providerReviewAttemptId({ job, provider, headSha });
  return `${identity.provider}:${identity.owner}/${identity.repo}#${identity.prNumber}@${identity.head}:attempt:${attemptId}`;
}

export function attestationPublicationId({ owner, repo, prNumber, headSha, reviews }) {
  const normalizedOwner = bounded(owner, 'publication owner', 100).toLowerCase();
  const normalizedRepo = bounded(repo, 'publication repository', 100).toLowerCase();
  const number = Number(prNumber);
  const head = String(headSha ?? '').toLowerCase();
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Publication PR number must be positive');
  if (!HEAD_SHA.test(head)) throw new Error('Publication head must be a lowercase 40-hex SHA');
  const checkId = (provider) => {
    const id = Number(reviews?.[provider]?.checkRunId ?? 0);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : 'none';
  };
  return createHash('sha256')
    .update('ores-attestation-publication-v1\0')
    .update(normalizedOwner).update('\0')
    .update(normalizedRepo).update('\0')
    .update(String(number)).update('\0')
    .update(head).update('\0')
    .update(`openai:${checkId('openai')}\0claude:${checkId('claude')}`)
    .digest('hex')
    .slice(0, 32);
}

export function reviewPublicationMarker({ publicationId, headSha }) {
  const id = String(publicationId ?? '');
  const head = String(headSha ?? '').toLowerCase();
  if (!ATTEMPT_ID.test(id)) throw new Error('Invalid review publication id');
  if (!HEAD_SHA.test(head)) throw new Error('Invalid review publication head');
  return `<!-- ores-review-publication v1 id=${id} head=${head} -->`;
}

export function parseReviewPublicationMarkers(body) {
  return [...String(body ?? '').matchAll(PUBLICATION_MARKER)].slice(0, 8).map((match) => ({
    id: match[1],
    headSha: match[2],
  }));
}
