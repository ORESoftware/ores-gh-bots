import { CHECK_NAMES, ownerIsAllowed, redactText } from '../../../packages/core/src/index.mjs';
import {
  checkExternalId,
  findLatestCheckRun,
  listAppInstallations,
  listInstallationRepositories,
  listOpenPullRequests,
} from '../../../packages/github/src/index.mjs';

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
    const totals = {
      installations: 0,
      repositories: 0,
      pullRequests: 0,
      jobs: 0,
      errors: 0,
      pruned: { deliveries: 0, jobs: 0, reviews: 0 },
    };
    try {
      totals.pruned = this.queue.prune();
      const installations = await listAppInstallations(this.client, this.auth.appJwt('orchestrator'));
      for (const installation of installations) {
        if (totals.repositories >= this.config.reconciliation.maxRepos) break;
        totals.installations += 1;
        try {
          const token = await this.auth.installationToken('orchestrator', installation.id);
          const remaining = this.config.reconciliation.maxRepos - totals.repositories;
          const repositories = await listInstallationRepositories(this.client, token, remaining);
          for (const repository of repositories) {
            if (totals.repositories >= this.config.reconciliation.maxRepos) break;
            if (!ownerIsAllowed(this.config, repository.owner?.login) || repository.archived || repository.disabled) continue;
            totals.repositories += 1;
            try {
              const owner = repository.owner.login;
              const repo = repository.name;
              const prs = await listOpenPullRequests(
                this.client,
                token,
                owner,
                repo,
                this.config.reconciliation.maxPrsPerRepo,
              );
              for (const pr of prs) {
                if (pr.draft) continue;
                totals.pullRequests += 1;
                const identity = {
                  owner,
                  repo,
                  prNumber: pr.number,
                  headSha: pr.head.sha,
                };
                const [openai, claude, gate] = await Promise.all([
                  findLatestCheckRun(this.client, token, owner, repo, pr.head.sha, CHECK_NAMES.openai, {
                    externalId: checkExternalId('openai', owner, repo, pr.number, pr.head.sha),
                    appId: this.config.apps.openai.id,
                  }),
                  findLatestCheckRun(this.client, token, owner, repo, pr.head.sha, CHECK_NAMES.claude, {
                    externalId: checkExternalId('claude', owner, repo, pr.number, pr.head.sha),
                    appId: this.config.apps.claude.id,
                  }),
                  findLatestCheckRun(this.client, token, owner, repo, pr.head.sha, CHECK_NAMES.gate, {
                    externalId: checkExternalId('gate', owner, repo, pr.number, pr.head.sha),
                    appId: this.config.apps.gate.id,
                  }),
                ]);
                const type = !openai || !claude ? 'review' : !gate ? 'gate' : null;
                if (!type) continue;
                const result = this.queue.enqueue({
                  type,
                  installationId: installation.id,
                  ...identity,
                  reason: `reconciler:missing-${type}-check`,
                  force: true,
                });
                if (result.inserted) totals.jobs += 1;
              }
            } catch (error) {
              totals.errors += 1;
              this.logger.warn('repository reconciliation failed', {
                repository: repository.full_name,
                error: redactText(error?.message ?? error),
              });
            }
          }
        } catch (error) {
          totals.errors += 1;
          this.logger.warn('installation reconciliation failed', {
            installationId: installation.id,
            error: redactText(error?.message ?? error),
          });
        }
      }
      this.metrics.increment('ores_reconciliations_total', { result: totals.errors ? 'partial' : 'success' });
      this.metrics.gauge('ores_reconciler_repositories', totals.repositories);
      this.logger.info('reconciliation complete', totals);
      return totals;
    } finally {
      this.running = false;
    }
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
