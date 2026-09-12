import { CHECK_NAMES, ownerIsAllowed, redactText } from '../../../packages/core/src/index.mjs';
import {
  findLatestCheckRun,
  listAppInstallations,
  listInstallationRepositories,
  listOpenPullRequests,
} from '../../../packages/github/src/index.mjs';

const EMPTY_TOTALS = Object.freeze({ installations: 0, repositories: 0, pullRequests: 0, jobs: 0, errors: 0 });

/** A new totals value with the given counters added; unknown keys in `delta` are ignored. */
function addTotals(totals, delta) {
  return Object.fromEntries(Object.keys(EMPTY_TOTALS).map((key) => [key, totals[key] + (delta[key] ?? 0)]));
}

/** Sequential async fold: `step` receives the state so far and returns the next state. */
async function foldAsync(items, initial, step) {
  return items.reduce(async (pending, item) => step(await pending, item), Promise.resolve(initial));
}

/** Resolve to `{ value }` on success or `{ error }` on rejection, so callers can branch without try/catch state. */
function settle(promise) {
  return promise.then((value) => ({ value }), (error) => ({ error }));
}

export class Reconciler {
  constructor({ config, client, auth, queue, logger, metrics }) {
    this.config = config;
    this.client = client;
    this.auth = auth;
    this.queue = queue;
    this.logger = logger;
    this.metrics = metrics;
    this.running = false;
  }

  async runOnce() {
    if (this.running || !this.config.reconciliation.enabled) return { skipped: true };
    this.running = true;
    try {
      const installations = await listAppInstallations(this.client, this.auth.appJwt('orchestrator'));
      // Totals are threaded through the folds as values: every step returns a new
      // totals object, so no counter is ever incremented in place across the
      // nested installation -> repository -> pull-request passes.
      const totals = await foldAsync(installations, EMPTY_TOTALS, (acc, installation) => this.#reconcileInstallation(acc, installation));
      this.metrics.increment('ores_reconciliations_total', { result: totals.errors ? 'partial' : 'success' });
      this.metrics.gauge('ores_reconciler_repositories', totals.repositories);
      this.logger.info('reconciliation complete', totals);
      return totals;
    } finally {
      this.running = false;
    }
  }

  #atRepositoryLimit(totals) {
    return totals.repositories >= this.config.reconciliation.maxRepos;
  }

  async #reconcileInstallation(totals, installation) {
    if (this.#atRepositoryLimit(totals)) return totals;
    const counted = addTotals(totals, { installations: 1 });
    const listed = await settle((async () => {
      const token = await this.auth.installationToken('orchestrator', installation.id);
      const remaining = this.config.reconciliation.maxRepos - counted.repositories;
      return { token, repositories: await listInstallationRepositories(this.client, token, remaining) };
    })());
    if (listed.error) {
      this.logger.warn('installation reconciliation failed', {
        installationId: installation.id,
        error: redactText(listed.error?.message ?? listed.error),
      });
      return addTotals(counted, { errors: 1 });
    }
    const { token, repositories } = listed.value;
    return foldAsync(repositories, counted, (acc, repository) => this.#reconcileRepository(acc, installation, token, repository));
  }

  async #reconcileRepository(totals, installation, token, repository) {
    if (this.#atRepositoryLimit(totals)) return totals;
    if (!ownerIsAllowed(this.config, repository.owner?.login) || repository.archived || repository.disabled) return totals;
    const counted = addTotals(totals, { repositories: 1 });
    const failed = (error) => {
      this.logger.warn('repository reconciliation failed', {
        repository: repository.full_name,
        error: redactText(error?.message ?? error),
      });
      return { errors: 1 };
    };
    const listed = await settle(listOpenPullRequests(
      this.client,
      token,
      repository.owner.login,
      repository.name,
      this.config.reconciliation.maxPrsPerRepo,
    ));
    if (listed.error) return addTotals(counted, failed(listed.error));
    // The first failing pull request stops the pass over this repository (as a thrown
    // error did before) but keeps the pull requests already counted.
    const outcome = await foldAsync(listed.value, { pullRequests: 0, jobs: 0, halted: false }, async (acc, pr) => {
      if (acc.halted || pr.draft) return acc;
      const seen = { ...acc, pullRequests: acc.pullRequests + 1 };
      const enqueued = await settle(this.#enqueueMissingCheck(installation, token, repository, pr));
      if (enqueued.error) return { ...seen, ...failed(enqueued.error), halted: true };
      return { ...seen, jobs: seen.jobs + enqueued.value };
    });
    return addTotals(counted, outcome);
  }

  /** Enqueue the job a pull request is missing, returning the number of jobs inserted (0 or 1). */
  async #enqueueMissingCheck(installation, token, repository, pr) {
    const [openai, claude, gate] = await Promise.all([
      findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.openai),
      findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.claude),
      findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.gate),
    ]);
    const type = !openai || !claude ? 'review' : !gate ? 'gate' : null;
    if (!type) return 0;
    const result = this.queue.enqueue({
      type,
      installationId: installation.id,
      owner: repository.owner.login,
      repo: repository.name,
      prNumber: pr.number,
      headSha: pr.head.sha,
      reason: `reconciler:missing-${type}-check`,
      force: true,
    });
    return result.inserted ? 1 : 0;
  }
}

export function startReconciler(reconciler, intervalMs, signal) {
  const timer = setInterval(() => {
    reconciler.runOnce().catch((error) => reconciler.logger.error('reconciliation failed', { error: redactText(error?.stack ?? error) }));
  }, intervalMs);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return reconciler.runOnce();
}
