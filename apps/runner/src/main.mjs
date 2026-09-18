#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import { createLogger, loadConfig, Metrics, redactObject, resolveCli, validateRuntimeConfig } from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';

const cli = resolveCli();
if (cli.help) {
  cli.printHelp();
  process.exit(0);
}
if (cli.command !== 'review') throw new Error(`Unexpected command for one-shot runner: ${cli.command || '<none>'}`);
const values = cli.values;
const owner = values.REVIEW_OWNER;
const repo = values.REVIEW_REPO;
const prNumber = Number(values.REVIEW_PR_NUMBER);
const headSha = values.REVIEW_HEAD_SHA ?? null;
let installationId = Number(values.REVIEW_INSTALLATION_ID ?? 0);
if (!owner || !repo || !Number.isInteger(prNumber) || prNumber < 1) {
  throw new Error('Usage: npm run review -- --owner OWNER --repo REPO --pr-number NUMBER [--head-sha SHA] [--installation-id ID]');
}

const config = loadConfig({ ...cli.env, QUEUE_PATH: ':memory:', GHA_MODE: 'disabled' });
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
    type: values.REVIEW_TYPE === 'gate' ? 'gate' : 'review',
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
    reason: values.REVIEW_REASON ?? 'one-shot-runner',
    force: true,
    attempts: 1,
    maxAttempts: 1,
  });
  console.log(JSON.stringify(redactObject(result), null, 2));
} finally {
  queue.close();
}
