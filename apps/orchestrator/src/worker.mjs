import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactText } from '../../../packages/core/src/index.mjs';

async function workerLoop({ queue, engine, config, logger, metrics, signal, index }) {
  const workerId = `${process.pid}:${index}:${randomUUID()}`;
  logger.info('worker started', { workerId });
  while (!signal.aborted) {
    const job = queue.claimNext(workerId, config.queue.leaseMs);
    if (!job) {
      await sleep(config.queue.pollMs, undefined, { signal }).catch(() => {});
      continue;
    }
    metrics.increment('ores_jobs_claimed_total', { type: job.type });
    const heartbeat = setInterval(() => {
      if (!queue.heartbeat(job.id, workerId, config.queue.leaseMs)) {
        logger.warn('job heartbeat lost', { workerId, jobId: job.id });
      }
    }, Math.max(1_000, Math.floor(config.queue.leaseMs / 3)));
    heartbeat.unref();
    try {
      await engine.process(job);
      if (!queue.complete(job.id, workerId)) throw new Error('job completion lease was lost');
      metrics.increment('ores_jobs_completed_total', { type: job.type });
    } catch (error) {
      const outcome = queue.fail(job, workerId, redactText(error?.stack ?? error));
      metrics.increment('ores_jobs_failed_total', { type: job.type, dead: String(outcome.dead) });
      logger.error('job failed', {
        workerId,
        jobId: job.id,
        repository: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
        attempts: job.attempts,
        dead: outcome.dead,
        retryDelayMs: outcome.delayMs,
        error: redactText(error?.stack ?? error),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  logger.info('worker stopped', { workerId });
}

export function startWorkerPool(options) {
  const tasks = Array.from({ length: options.config.queue.workerConcurrency }, (_, index) => workerLoop({ ...options, index }));
  return Promise.allSettled(tasks);
}
