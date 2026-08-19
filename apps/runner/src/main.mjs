#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  Metrics,
  ownerIsAllowed,
  redactObject,
  validateControlPlaneConfig,
  validateRuntimeConfig,
} from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';

const ALLOWED_ARGUMENTS = new Set([
  'owner',
  'repo',
  'pr-number',
  'head-sha',
  'installation-id',
  'reason',
  'type',
]);

function args(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected positional argument: ${item}`);
    const separator = item.indexOf('=');
    const key = separator === -1 ? item.slice(2) : item.slice(2, separator);
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Unknown argument: --${key}`);
    if (Object.hasOwn(output, key)) throw new Error(`Duplicate argument: --${key}`);
    let value = separator === -1 ? null : item.slice(separator + 1);
    if (value === null) {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      index += 1;
    }
    output[key] = value;
  }
  return output;
}

function positiveInteger(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return 0;
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) throw new Error(`${field} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is outside the safe integer range`);
  return parsed;
}

function bounded(value, field, pattern, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength || !pattern.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

const input = args(process.argv.slice(2));
const owner = bounded(input.owner ?? process.env.REVIEW_OWNER, 'owner', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u, 100);
const repo = bounded(input.repo ?? process.env.REVIEW_REPO, 'repo', /^[A-Za-z0-9_.-]+$/u, 100);
const prNumber = positiveInteger(input['pr-number'] ?? process.env.REVIEW_PR_NUMBER, 'pr-number');
const headSha = bounded(input['head-sha'] ?? process.env.REVIEW_HEAD_SHA, 'head-sha', /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u, 64);
let installationId = positiveInteger(
  input['installation-id'] ?? process.env.REVIEW_INSTALLATION_ID,
  'installation-id',
  { optional: true },
);
const reason = bounded(
  input.reason ?? process.env.REVIEW_REASON ?? 'one-shot-runner',
  'reason',
  /^[^\0\r\n]+$/u,
  256,
);
const type = input.type ?? process.env.REVIEW_TYPE ?? 'review';
if (!['review', 'gate'].includes(type)) throw new Error('type must be review or gate');

const config = loadConfig({ ...process.env, QUEUE_PATH: ':memory:', GHA_MODE: 'disabled' });
validateRuntimeConfig(config, { webhook: false, providers: true });
validateControlPlaneConfig(config, { webhook: false });
if (!ownerIsAllowed(config, owner)) throw new Error(`owner is not allowed by runtime policy: ${owner}`);

const logger = createLogger({ service: 'ores-gh-bots-runner' });
const metrics = new Metrics();
const queue = new SqliteQueue({ path: ':memory:', maxAttempts: 1 });
const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
const auth = new AppAuth({ client, apps: config.apps, logger });
if (!installationId) installationId = await auth.installationIdForRepo('orchestrator', owner, repo);
const engine = new ReviewEngine({ config, client, auth, queue, logger, metrics });

try {
  const result = await engine.process({
    id: 0,
    type,
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
    reason,
    force: true,
    attempts: 1,
    maxAttempts: 1,
  });
  console.log(JSON.stringify(redactObject(result), null, 2));
} finally {
  queue.close();
}
