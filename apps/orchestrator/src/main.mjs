#!/usr/bin/env node
import { AppAuth, GitHubClient } from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  Metrics,
  resolveCli,
  validateControlPlaneConfig,
  validateRuntimeConfig,
} from '../../../packages/core/src/index.mjs';
import { SqliteQueue } from '../../../packages/queue/src/index.mjs';
import { ReviewEngine } from '../../../packages/engine/src/index.mjs';
import { Reconciler, startReconciler } from './reconciler.mjs';
import { createWebhookServer } from './server.mjs';
import { createWorkerPool } from './worker.mjs';

const cli = resolveCli();
if (cli.help) {
  cli.printHelp();
  process.exit(0);
}
const workerOnly = cli.values.ORES_WORKER_ONLY;
const config = loadConfig(cli.env);
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
let listenPromise = Promise.resolve();
let shutdownPromise = null;

const workerPool = createWorkerPool({
  queue,
  engine,
  config,
  logger: logger.child({ component: 'worker' }),
  metrics,
  signal: abortController.signal,
  onFatal: () => {
    ready = false;
    requestShutdown('worker-failure', true);
  },
});

if (!workerOnly) {
  server = createWebhookServer({
    config,
    queue,
    logger: logger.child({ component: 'http' }),
    metrics,
    readiness: () => ready && workerPool.isHealthy(),
  });
  listenPromise = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, '0.0.0.0', resolve);
  });
  await listenPromise;
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
if (config.reconciliation.enabled && !abortController.signal.aborted) {
  startReconciler(reconciler, config.reconciliation.intervalMs, abortController.signal).catch((error) => {
    logger.error('initial reconciliation failed', { error: error?.stack ?? String(error) });
  });
}
ready = !abortController.signal.aborted;

function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  ready = false;
  logger.info('shutting down', { signal });
  abortController.abort();
  shutdownPromise = (async () => {
    // A stuck engine or HTTP client must not leave a zombie process forever.
    // Forced exit intentionally leaves outstanding leases for startup recovery.
    const deadline = setTimeout(() => {
      logger.error('shutdown deadline exceeded');
      process.exit(1);
    }, 30_000);
    deadline.unref();
    try {
      await listenPromise.catch(() => {});
      if (server) await new Promise((resolve) => server.close(resolve));
      await workerPool.done;
      queue.close();
    } finally {
      clearTimeout(deadline);
    }
  })();
  return shutdownPromise;
}

function requestShutdown(signal, failed = false) {
  if (failed) process.exitCode = 1;
  void shutdown(signal).catch(() => {
    process.exitCode = 1;
    logger.error('orderly shutdown failed');
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => requestShutdown(signal));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error: error.stack ?? String(error) });
  requestShutdown('uncaughtException', true);
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandled rejection', { error: error?.stack ?? String(error) });
  requestShutdown('unhandledRejection', true);
});
