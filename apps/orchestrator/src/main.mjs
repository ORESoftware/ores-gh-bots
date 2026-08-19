#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  Metrics,
  validateControlPlaneConfig,
  validateRuntimeConfig,
} from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';
import { Reconciler, startReconciler } from './reconciler.mjs';
import { createWebhookServer } from './server.mjs';
import { startWorkerPool } from './worker.mjs';

const workerOnly = process.argv.includes('--worker-only');
const config = loadConfig();
validateRuntimeConfig(config, {
  webhook: !workerOnly,
  providers: config.gha.mode !== 'offload',
});
validateControlPlaneConfig(config, { webhook: !workerOnly });

const logger = createLogger({ service: 'ores-gh-bots' });
const metrics = new Metrics();
const queue = new SqliteQueue({ path: config.queue.path, maxAttempts: config.queue.maxAttempts });
const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
const auth = new AppAuth({ client, apps: config.apps, logger });
const engine = new ReviewEngine({ config, client, auth, queue, logger, metrics });
const abortController = new AbortController();
let ready = false;
let server = null;

const workerPromise = startWorkerPool({
  queue,
  engine,
  config,
  logger: logger.child({ component: 'worker' }),
  metrics,
  signal: abortController.signal,
});

if (!workerOnly) {
  server = createWebhookServer({ config, queue, logger: logger.child({ component: 'http' }), metrics, readiness: () => ready });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, '0.0.0.0', resolve);
  });
  logger.info('webhook server listening', { port: config.server.port, path: config.server.webhookPath });
}

const reconciler = new Reconciler({
  config,
  client,
  auth,
  queue,
  logger: logger.child({ component: 'reconciler' }),
  metrics,
});
if (config.reconciliation.enabled) {
  startReconciler(reconciler, config.reconciliation.intervalMs, abortController.signal).catch((error) => {
    logger.error('initial reconciliation failed', { error: error?.stack ?? String(error) });
  });
}
ready = true;

async function shutdown(signal) {
  if (abortController.signal.aborted) return;
  ready = false;
  logger.info('shutting down', { signal });
  abortController.abort();
  if (server) await new Promise((resolve) => server.close(resolve));
  await workerPromise;
  queue.close();
}

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown(signal));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error: error.stack ?? String(error) });
  shutdown('uncaughtException').finally(() => { process.exitCode = 1; });
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled rejection', { error: error?.stack ?? String(error) });
  shutdown('unhandledRejection').finally(() => { process.exitCode = 1; });
});
