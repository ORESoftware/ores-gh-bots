#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  Metrics,
  ownerIsAllowed,
  redactObject,
  resolveCli,
  validateControlPlaneConfig,
  validateRuntimeConfig,
} from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';

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

const cli = resolveCli();
if (cli.help) {
  cli.printHelp();
  process.exit(0);
}
if (cli.command && cli.command !== 'review') throw new Error(`Unexpected command: ${cli.command}`);
const owner = bounded(cli.env.REVIEW_OWNER, 'owner', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u, 100);
const repo = bounded(cli.env.REVIEW_REPO, 'repo', /^[A-Za-z0-9_.-]+$/u, 100);
const prNumber = positiveInteger(cli.values.REVIEW_PR_NUMBER ?? cli.env.REVIEW_PR_NUMBER, 'pr-number');
const headSha = bounded(cli.env.REVIEW_HEAD_SHA, 'head-sha', /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u, 64);
let installationId = positiveInteger(
  cli.values.REVIEW_INSTALLATION_ID ?? cli.env.REVIEW_INSTALLATION_ID,
  'installation-id',
  { optional: true },
);
const reason = bounded(
  cli.env.REVIEW_REASON,
  'reason',
  /^[^\0\r\n]+$/u,
  256,
);
const type = cli.env.REVIEW_TYPE;
if (!['review', 'gate'].includes(type)) throw new Error('type must be review or gate');

const config = loadConfig({ ...cli.env, QUEUE_PATH: ':memory:', GHA_MODE: 'disabled' });
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
