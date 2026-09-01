import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactText } from '../../../packages/core/src/redact.mjs';

export class WorkerPoolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerPoolError';
  }
}

async function workerLoop({ queue, engine, config, logger, metrics, signal, index, onFatal }) {
  const workerId = `${process.pid}:${index}:${randomUUID()}`;
  logger.info('worker started', { workerId });
  try {
    while (!signal.aborted) {
      // Queue infrastructure errors must escape to the supervisor, not silently
      // remove a worker while the HTTP process continues reporting readiness.
      const job = queue.claimNext(workerId, config.queue.leaseMs);
      if (!job) {
        try { await sleep(config.queue.pollMs, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
        continue;
      }
      metrics.increment('ores_jobs_claimed_total', { type: job.type });
      let heartbeatError = null;
      const heartbeat = setInterval(() => {
        if (heartbeatError) return;
        try {
          if (!queue.heartbeat(job.id, workerId, config.queue.leaseMs)) {
            throw new WorkerPoolError('job heartbeat lease was lost');
          }
        } catch (error) {
          heartbeatError = error instanceof Error ? error : new WorkerPoolError('heartbeat threw a non-Error value');
          // Never throw out of an interval callback. Stop new claims and make
          // readiness unhealthy immediately, even while this engine drains.
          onFatal(heartbeatError);
        }
      }, Math.max(1_000, Math.floor(config.queue.leaseMs / 3)));
      heartbeat.unref();
      let executionError = null;
      try { await engine.process(job); }
      catch (error) { executionError = error instanceof Error ? error : new WorkerPoolError('review engine threw a non-Error value'); }
      finally { clearInterval(heartbeat); }

      // A stale worker must not acknowledge or reschedule a lease it lost.
      // Publication fencing inside the review engine is a separate control.
      if (heartbeatError) throw heartbeatError;
      if (executionError !== null) {
        const outcome = queue.fail(job, workerId, redactText(executionError?.stack ?? executionError));
        if (outcome?.updated !== true) throw new WorkerPoolError('job failure lease was lost');
        metrics.increment('ores_jobs_failed_total', { type: job.type, dead: String(outcome.dead) });
        logger.error('job failed', {
          workerId,
          jobId: job.id,
          repository: `${job.owner}/${job.repo}`,
          prNumber: job.prNumber,
          attempts: job.attempts,
          dead: outcome.dead,
          retryDelayMs: outcome.delayMs,
          error: redactText(executionError?.stack ?? executionError),
        });
        continue;
      }
      if (!queue.complete(job.id, workerId)) throw new WorkerPoolError('job completion lease was lost');
      metrics.increment('ores_jobs_completed_total', { type: job.type });
    }
  } finally {
    logger.info('worker stopped', { workerId });
  }
}

/**
 * Fail-stop supervisor: on the first infrastructure failure, stop claiming work
 * and report unhealthy immediately. `done` settles only after every active job
 * has drained, so callers may then close SQLite safely. No in-process restarts
 * or extra model calls are introduced.
 */
export function createWorkerPool(options) {
  const expected = options.config.queue.workerConcurrency;
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 64) {
    throw new WorkerPoolError('workerConcurrency must be an integer between 1 and 64');
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let active = 0;
  let fatalError = null;
  const onFatal = (error) => {
    if (fatalError !== null) return;
    fatalError = error instanceof Error ? error : new WorkerPoolError('worker failed with a non-Error value');
    controller.abort(fatalError);
    options.logger.error('worker pool unhealthy', { error: redactText(fatalError.stack ?? fatalError) });
    try { options.onFatal?.(fatalError); }
    catch (callbackError) {
      options.logger.error('worker failure callback failed', { error: redactText(callbackError?.stack ?? callbackError) });
    }
  };
  // Defer startup so lifecycle callbacks cannot run before the caller has its
  // pool handle and has initialized its HTTP-listener/shutdown state.
  const tasks = Array.from({ length: expected }, (_, index) => Promise.resolve().then(async () => {
    if (signal.aborted) return;
    active += 1;
    try { await workerLoop({ ...options, signal, index, onFatal }); }
    catch (error) { onFatal(error); throw error; }
    finally { active -= 1; }
  }));
  const done = Promise.allSettled(tasks);
  return Object.freeze({
    done,
    isHealthy: () => !signal.aborted && fatalError === null && active === expected,
    snapshot: () => ({ expected, active, failed: fatalError !== null, stopping: signal.aborted }),
    stop: () => controller.abort(),
  });
}

// Preserve the original promise-returning API for existing callers.
export function startWorkerPool(options) {
  return createWorkerPool(options).done;
}
