// Peer consult: after both providers have reviewed the exact head
// independently, a provider that approved is invoked again with the other
// provider's review in hand — Claude answers ChatGPT's findings and the reverse.
//
// The consult can withdraw an approval and can never grant one. A reviewer
// that blocked in the independent round is not asked again, so text an attacker
// steered into one model's review cannot be used to talk the other model out of
// a block. Independent round results are what the consult starts from; the
// consult result replaces only the consulted provider's review.

import { PROVIDERS } from './constants.mjs';

export const PEER_CONSULT_MODES = Object.freeze(['off', 'disagreement', 'always']);

const MAX_PEER_FINDINGS = 20;

export function peerConsultMode(value) {
  const mode = String(value ?? '').trim().toLowerCase() || 'off';
  if (!PEER_CONSULT_MODES.includes(mode)) throw new Error(`Invalid REVIEW_PEER_CONSULT value: ${value}`);
  return mode;
}

function completed(review) {
  return Boolean(review) && !review.error && typeof review.verdict === 'string';
}

export function peerConsultPlan({ mode, reviews }) {
  if (mode === 'off' || !PROVIDERS.every((provider) => completed(reviews?.[provider]))) return [];
  return PROVIDERS.flatMap((provider) => {
    const peer = PROVIDERS.find((candidate) => candidate !== provider);
    const approved = reviews[provider].verdict === 'approve';
    const peerBlocked = reviews[peer].verdict !== 'approve';
    return approved && (mode === 'always' || peerBlocked) ? [{ provider, peer }] : [];
  });
}

export function peerReviewForPrompt(peer, review) {
  return {
    reviewer: peer,
    verdict: review.verdict,
    risk: review.risk,
    summary: review.summary,
    blocking_reasons: review.blocking_reasons ?? [],
    findings: (review.findings ?? []).slice(0, MAX_PEER_FINDINGS),
  };
}

// The consult never grants an approval: a provider is consulted only after it
// approved, so any other outcome is a withdrawal and approve stays approve.
export function applyConsultResult({ consulted }) {
  return { ...consulted, consult: consulted.verdict === 'approve' ? 'upheld' : 'withdrawn' };
}
