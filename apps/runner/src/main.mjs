#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import { createLogger, loadConfig, Metrics, redactObject, validateRuntimeConfig } from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';

function args(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const [key, inline] = item.slice(2).split('=', 2);
    output[key] = inline ?? argv[++index];
  }
  return output;
}

const input = args(process.argv.slice(2));
const owner = input.owner ?? process.env.REVIEW_OWNER;
const repo = input.repo ?? process.env.REVIEW_REPO;
const prNumber = Number(input['pr-number'] ?? process.env.REVIEW_PR_NUMBER);
const headSha = input['head-sha'] ?? process.env.REVIEW_HEAD_SHA ?? null;
let installationId = Number(input['installation-id'] ?? process.env.REVIEW_INSTALLATION_ID ?? 0);
if (!owner || !repo || !Number.isInteger(prNumber) || prNumber < 1) {
  throw new Error('Usage: npm run review -- --owner OWNER --repo REPO --pr-number NUMBER [--head-sha SHA] [--installation-id ID]');
}

const config = loadConfig({ ...process.env, QUEUE_PATH: ':memory:', GHA_MODE: 'disabled' });
validateRuntimeConfig(config, { webhook: false, providers: true });
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
    type: input.type === 'gate' ? 'gate' : 'review',
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
    reason: input.reason ?? process.env.REVIEW_REASON ?? 'one-shot-runner',
    force: true,
    attempts: 1,
    maxAttempts: 1,
  });
  console.log(JSON.stringify(redactObject(result), null, 2));
} finally {
  queue.close();
}
