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
const FIELD_PATTERN = /^([a-z]{1,16})=(\S{1,128})$/;
const MAX_MARKERS = 16;

const FAMILY = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;

// The grammar is closed: each marker kind carries exactly these keys, once
// each, and every value must match its form. Anything else is not a marker.
const MARKER_SCHEMAS = Object.freeze({
  tag: Object.freeze({ to: FAMILY, from: FAMILY, session: SESSION, kind: /^(?:review|merge|fix)$/, head: HEAD_SHA }),
  review: Object.freeze({ agent: FAMILY, session: SESSION, head: HEAD_SHA, verdict: /^(?:approve|request-changes)$/ }),
  author: Object.freeze({ agent: FAMILY, session: SESSION }),
});

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
  const name = String(family ?? '').toLowerCase();
  return Object.hasOwn(FAMILY_PROVIDERS, name) ? FAMILY_PROVIDERS[name] : null;
}

export function familyForProvider(provider) {
  return Object.hasOwn(PROVIDER_FAMILIES, provider) ? PROVIDER_FAMILIES[provider] : null;
}

function parseFields(kind, words) {
  const schema = MARKER_SCHEMAS[kind];
  const pairs = words.map((word) => FIELD_PATTERN.exec(word));
  if (pairs.some((pair) => !pair) || pairs.length !== Object.keys(schema).length) return null;
  const keys = pairs.map((pair) => pair[1]);
  if (new Set(keys).size !== keys.length) return null;
  if (!pairs.every(([, key, value]) => Object.hasOwn(schema, key) && schema[key].test(value))) return null;
  return Object.fromEntries(pairs.map(([, key, value]) => [key, value]));
}

export function parseAgentMarkers(body) {
  const matches = [...String(body ?? '').matchAll(MARKER_PATTERN)].slice(0, MAX_MARKERS);
  return matches.flatMap((match) => {
    const fields = parseFields(match[2], match[1].split(' ').slice(2));
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
