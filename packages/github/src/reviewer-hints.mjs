import { createHash } from 'node:crypto';
import {
  addCandidate,
  boundedString,
  candidateKey,
  normalizeReviewerLogin,
  plainObject,
  pullRequestReference,
  REVIEWER_HINTS_SCHEMA,
  sameLogin,
} from './reviewer-validation.mjs';

const MAX_HINT_MESSAGES = 100;
const MAX_HINT_LINKS = 20;
const GITHUB_SENDER = /(?:^|[\s<])(?:notifications|noreply)@github\.com(?:[\s>]|$)/iu;

function hintId(source, messageId, reference) {
  return createHash('sha256')
    .update(`${source}\0${messageId}\0${candidateKey(reference.owner, reference.repo, reference.prNumber)}`)
    .digest('hex')
    .slice(0, 24);
}

export function parseReviewerHints(document, expectedReviewer) {
  if (document === null || document === undefined) return [];
  const reviewer = normalizeReviewerLogin(expectedReviewer);
  const root = plainObject(document, 'reviewer hints document', new Set(['schema', 'generated_at', 'reviewer', 'messages']));
  if (root.schema !== REVIEWER_HINTS_SCHEMA) throw new Error(`unsupported reviewer hints schema: ${String(root.schema)}`);
  if (root.reviewer && !sameLogin(normalizeReviewerLogin(root.reviewer), reviewer)) {
    throw new Error('reviewer hints document is bound to a different reviewer');
  }
  if (!Array.isArray(root.messages)) throw new Error('reviewer hints messages must be an array');
  if (root.messages.length > MAX_HINT_MESSAGES) throw new Error(`reviewer hints exceed ${MAX_HINT_MESSAGES} messages`);

  const references = new Map();
  for (const [index, item] of root.messages.entries()) {
    const message = plainObject(item, `reviewer hints message ${index + 1}`, new Set([
      'source', 'message_id', 'from', 'subject', 'snippet', 'links',
    ]));
    const source = boundedString(message.source, `reviewer hints message ${index + 1} source`, 32, true).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(source)) throw new Error(`reviewer hints message ${index + 1} source is invalid`);
    const messageId = boundedString(message.message_id, `reviewer hints message ${index + 1} message_id`, 512, true);
    const from = boundedString(message.from, `reviewer hints message ${index + 1} from`, 512, true);
    const subject = boundedString(message.subject, `reviewer hints message ${index + 1} subject`, 1_000);
    const snippet = boundedString(message.snippet, `reviewer hints message ${index + 1} snippet`, 4_000);
    if (!GITHUB_SENDER.test(from)) continue;
    if (message.links !== undefined && !Array.isArray(message.links)) throw new Error(`reviewer hints message ${index + 1} links must be an array`);
    const links = message.links ?? [];
    if (links.length > MAX_HINT_LINKS) throw new Error(`reviewer hints message ${index + 1} exceeds ${MAX_HINT_LINKS} links`);

    const candidates = [];
    for (const [linkIndex, link] of links.entries()) {
      const parsed = pullRequestReference(boundedString(link, `reviewer hints message ${index + 1} link ${linkIndex + 1}`, 2_048, true));
      if (parsed) candidates.push(parsed);
    }
    for (const match of `${subject}\n${snippet}`.matchAll(/https:\/\/github\.com\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,10}(?:[^\s<>]*)?/gu)) {
      const parsed = pullRequestReference(match[0]);
      if (parsed) candidates.push(parsed);
    }
    for (const match of subject.matchAll(/\[([A-Za-z0-9][A-Za-z0-9.-]{0,38})\/([A-Za-z0-9_.-]{1,100})\][^\r\n]{0,800}?\(#(\d{1,10})\)/gu)) {
      const parsed = pullRequestReference(`https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`);
      if (parsed) candidates.push(parsed);
    }
    for (const reference of candidates) addCandidate(references, reference, `email:${source}`, hintId(source, messageId, reference));
  }

  return [...references.values()]
    .sort((left, right) => candidateKey(left.owner, left.repo, left.prNumber).localeCompare(candidateKey(right.owner, right.repo, right.prNumber)))
    .map((reference) => Object.freeze({
      owner: reference.owner,
      repo: reference.repo,
      prNumber: reference.prNumber,
      sources: Object.freeze([...reference.sources].sort()),
      hintIds: Object.freeze([...reference.hintIds].sort()),
    }));
}
