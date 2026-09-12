import {
  CHECK_NAMES,
  contractAdmissionPolicyForRepository,
  ownerIsAllowed,
  redactText,
} from '../../../packages/core/src/index.mjs';
import {
  findLatestCheckRun,
  listAppInstallations,
  listInstallationRepositories,
  listOpenPullRequests,
} from '../../../packages/github/src/index.mjs';

export function contractAdmissionNeedsRefresh({
  config,
  queue,
  repository,
  pullRequest,
  gate,
  nowMs = Date.now(),
}) {
  const policy = contractAdmissionPolicyForRepository(
    config.contractAdmission?.policy,
    repository.full_name,
  );
  if (!policy || gate?.status !== 'completed') return false;
  const receipts = queue.getContractAdmissions({
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
  });
  const receiptsByKind = new Map(receipts.map((receipt) => [receipt.projectionKind, receipt]));
  const refreshBefore = nowMs + Math.max(60_000, Number(config.reconciliation.intervalMs));
  return policy.projections.some((projection) => {
    const receipt = receiptsByKind.get(projection.kind);
    if (!receipt) return true;
    if (receipt.expiresAt <= refreshBefore) return true;
    if (receipt.producerCheckName !== policy.producer.checkName) return true;
    if (Number(receipt.producerAppId) !== Number(policy.producer.checkAppId)) return true;
    if (receipt.result?.repository?.toLowerCase() !== repository.full_name.toLowerCase()) return true;
    if (receipt.result?.headSha !== pullRequest.head.sha) return true;
    if (receipt.result?.projectionKind !== projection.kind) return true;
    return false;
  });
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
    const totals = {
      installations: 0,
      repositories: 0,
      pullRequests: 0,
      jobs: 0,
      contractRefreshes: 0,
      errors: 0,
    };
    try {
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
              const prs = await listOpenPullRequests(
                this.client,
                token,
                repository.owner.login,
                repository.name,
                this.config.reconciliation.maxPrsPerRepo,
              );
              for (const pr of prs) {
                if (pr.draft) continue;
                totals.pullRequests += 1;
                const [openai, claude, gate] = await Promise.all([
                  findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.openai),
                  findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.claude),
                  findLatestCheckRun(this.client, token, repository.owner.login, repository.name, pr.head.sha, CHECK_NAMES.gate),
                ]);
                const contractRefresh = contractAdmissionNeedsRefresh({
                  config: this.config,
                  queue: this.queue,
                  repository,
                  pullRequest: pr,
                  gate,
                });
                const type = !openai || !claude ? 'review' : !gate || contractRefresh ? 'gate' : null;
                if (!type) continue;
                const reason = contractRefresh
                  ? 'reconciler:contract-admission-refresh'
                  : `reconciler:missing-${type}-check`;
                const result = this.queue.enqueue({
                  type,
                  installationId: installation.id,
                  owner: repository.owner.login,
                  repo: repository.name,
                  prNumber: pr.number,
                  headSha: pr.head.sha,
                  reason,
                  force: true,
                });
                if (result.inserted) {
                  totals.jobs += 1;
                  if (contractRefresh) totals.contractRefreshes += 1;
                }
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
      this.metrics.gauge('ores_reconciler_contract_refreshes', totals.contractRefreshes);
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
