import { createHash } from 'node:crypto';

const HEAD_SHA = /^[0-9a-f]{40}$/u;
const PROVIDER = /^(?:openai|claude)$/u;
const ATTEMPT_ID = /^[0-9a-f]{32}$/u;
const REVIEW_VERDICT = /^(?:approve|comment|request_changes)$/u;
const REVIEW_RISK = /^(?:low|medium|high|critical)$/u;
const PROVIDER_RECEIPT = /^<!-- ores-provider-review-receipt v1 verdict=(approve|comment|request_changes) risk=(low|medium|high|critical) confidence_bp=(\d{1,5}) -->$/u;
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

export function providerReviewReceiptMarker(review) {
  const verdict = String(review?.verdict ?? '');
  const risk = String(review?.risk ?? '');
  const confidence = Number(review?.confidence);
  if (!REVIEW_VERDICT.test(verdict)) throw new Error('Invalid provider review receipt verdict');
  if (!REVIEW_RISK.test(risk)) throw new Error('Invalid provider review receipt risk');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Invalid provider review receipt confidence');
  }
  const confidenceBp = Math.round(confidence * 10_000);
  return `<!-- ores-provider-review-receipt v1 verdict=${verdict} risk=${risk} confidence_bp=${confidenceBp} -->`;
}

export function recoverProviderReviewFromCheck(check) {
  if (check?.status !== 'completed') return null;
  const summary = String(check?.output?.summary ?? '');
  const [firstLine, ...rest] = summary.split('\n');
  const match = PROVIDER_RECEIPT.exec(firstLine ?? '');
  if (!match) return null;
  const confidenceBp = Number(match[3]);
  if (!Number.isSafeInteger(confidenceBp) || confidenceBp < 0 || confidenceBp > 10_000) return null;
  const verdict = match[1];
  const expectedConclusion = verdict === 'approve' ? 'success' : 'failure';
  if (String(check.conclusion ?? '') !== expectedConclusion) return null;
  const recoveredSummary = rest.join('\n').trim() || 'Recovered exact provider review receipt.';
  return Object.freeze({
    verdict,
    summary: recoveredSummary,
    confidence: confidenceBp / 10_000,
    risk: match[2],
    findings: Object.freeze([]),
    tests: Object.freeze([]),
    blocking_reasons: Object.freeze(verdict === 'request_changes' ? ['recovered exact provider request_changes verdict'] : []),
    checkRunId: Number(check.id),
    recovered: true,
  });
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
