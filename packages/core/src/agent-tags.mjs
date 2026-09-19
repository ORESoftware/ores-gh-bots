// The agent-to-agent tagging protocol defined in ORESoftware/my-ai SHARED.md
// ("agents may merge PRs — only after two independent agent reviews"):
//
//   label    agent-tag:<family>                                  the queue
//   request  <!-- ores-agent-tag v1 to= from= session= kind= head= -->
//   review   <!-- ores-agent-review v1 agent= session= head= verdict= -->
//
// Marker text arrives in PR comments and is untrusted. Parsing is closed: an
// unknown version, a malformed field, or an oversized marker yields nothing.

import { PROVIDERS } from './constants.mjs';

export const AGENT_TAG_LABEL_PREFIX = 'agent-tag:';

const MARKER_PATTERN = /<!-- (ores-agent-(tag|review|author) v1 [^>]{1,512}?) ?-->/g;
const FIELD_PATTERN = /^[a-z][a-z0-9_-]{0,31}=[A-Za-z0-9._:/#@-]{1,128}$/;
const MAX_MARKERS = 16;

// Families whose review this service can perform, keyed to its providers.
const FAMILY_PROVIDERS = Object.freeze({
  claude: 'claude',
  anthropic: 'claude',
  codex: 'openai',
  chatgpt: 'openai',
  openai: 'openai',
});

const PROVIDER_FAMILIES = Object.freeze({ openai: 'codex', claude: 'claude' });

export function providerForFamily(family) {
  return FAMILY_PROVIDERS[String(family ?? '').toLowerCase()] ?? null;
}

export function familyForProvider(provider) {
  return PROVIDER_FAMILIES[provider] ?? null;
}

function parseFields(words) {
  if (!words.every((word) => FIELD_PATTERN.test(word))) return null;
  return Object.fromEntries(words.map((word) => {
    const index = word.indexOf('=');
    return [word.slice(0, index), word.slice(index + 1).toLowerCase()];
  }));
}

export function parseAgentMarkers(body) {
  const matches = [...String(body ?? '').matchAll(MARKER_PATTERN)].slice(0, MAX_MARKERS);
  return matches.flatMap((match) => {
    const fields = parseFields(match[1].split(/\s+/).slice(2));
    return fields ? [{ kind: match[2], fields }] : [];
  });
}

// A review request this service can act on: addressed to a family it hosts.
export function reviewTagProviders(body) {
  const providers = parseAgentMarkers(body)
    .filter((marker) => marker.kind === 'tag' && marker.fields.kind === 'review')
    .map((marker) => providerForFamily(marker.fields.to))
    .filter(Boolean);
  return PROVIDERS.filter((provider) => providers.includes(provider));
}

export function labelProvider(labelName) {
  const name = String(labelName ?? '').toLowerCase();
  return name.startsWith(AGENT_TAG_LABEL_PREFIX)
    ? providerForFamily(name.slice(AGENT_TAG_LABEL_PREFIX.length))
    : null;
}

// Only an approval attests approval; `comment` and `request_changes` both block
// this gate, so both publish as request-changes.
export function attestationVerdict(review) {
  return review?.verdict === 'approve' ? 'approve' : 'request-changes';
}

export function buildReviewAttestation({ provider, headSha, review }) {
  const family = familyForProvider(provider);
  if (!family || !/^[0-9a-f]{40}$/.test(String(headSha ?? ''))) return null;
  if (!review || review.error || !review.checkRunId) return null;
  return `<!-- ores-agent-review v1 agent=${family} session=ores-gh-bots:${provider}:${review.checkRunId} head=${headSha} verdict=${attestationVerdict(review)} -->`;
}

export function buildReviewAttestations({ headSha, reviews }) {
  return PROVIDERS
    .map((provider) => buildReviewAttestation({ provider, headSha, review: reviews?.[provider] }))
    .filter(Boolean);
}
