import { ownerIsAllowed, redactText } from '../../../packages/core/src/index.mjs';
import {
  buildReviewerQueue,
  findSuccessfulGateCheck,
  submitBoundReviewerApproval,
} from '../../../packages/github/src/index.mjs';

const APPROVAL_MODE = 'requested-gate-success';

function repositoryParts(value) {
  const [owner, repo, ...rest] = String(value ?? '').split('/');
  if (!owner || !repo || rest.length) return null;
  return { owner, repo };
}

function approvalBody(candidate) {
  return [
    'The exact pull-request head passed both configured AI reviews and every required CI context.',
    '',
    `Repository: \`${candidate.repository}\``,
    `Pull request: \`#${candidate.pr_number}\``,
    `Head SHA: \`${candidate.head_sha}\``,
  ].join('\n');
}

export class ReviewerReconciler {
  constructor({ config, client, logger, metrics }) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.metrics = metrics;
    this.running = false;
  }

  async runOnce() {
    if (this.running) return { skipped: 'already-running' };
    if (this.config.reviewer.approvalMode !== APPROVAL_MODE) return { skipped: 'disabled' };
    this.running = true;
    const totals = {
      candidates: 0,
      actionable: 0,
      approved: 0,
      alreadySubmitted: 0,
      held: 0,
      outsideAllowlist: 0,
      stale: 0,
      errors: 0,
    };
    try {
      const plan = await buildReviewerQueue({
        client: this.client,
        token: this.config.reviewer.token,
        reviewerLogin: this.config.reviewer.login,
        limit: this.config.reviewer.maxItems,
      });
      totals.candidates = plan.count;
      totals.actionable = plan.review_count;
      for (const candidate of plan.candidates) {
        if (candidate.disposition !== 'review') continue;
        const repository = repositoryParts(candidate.repository);
        if (!repository || !ownerIsAllowed(this.config, repository.owner)) {
          totals.outsideAllowlist += 1;
          continue;
        }
        try {
          const gate = await findSuccessfulGateCheck({
            client: this.client,
            token: this.config.reviewer.token,
            owner: repository.owner,
            repo: repository.repo,
            prNumber: candidate.pr_number,
            headSha: candidate.head_sha,
            gateAppId: this.config.apps.gate.id,
          });
          if (!gate) {
            totals.held += 1;
            continue;
          }
          const result = await submitBoundReviewerApproval({
            client: this.client,
            token: this.config.reviewer.token,
            reviewerLogin: this.config.reviewer.login,
            owner: repository.owner,
            repo: repository.repo,
            prNumber: candidate.pr_number,
            expectedHeadSha: candidate.head_sha,
            body: approvalBody(candidate),
            gateCheckRunId: gate.id,
            gateAppId: this.config.apps.gate.id,
          });
          if (result.status === 'submitted') totals.approved += 1;
          else if (result.status === 'already-submitted') totals.alreadySubmitted += 1;
          else totals.stale += 1;
        } catch (error) {
          totals.errors += 1;
          this.logger.warn('bound reviewer reconciliation failed', {
            repository: candidate.repository,
            prNumber: candidate.pr_number,
            headSha: candidate.head_sha,
            error: redactText(error?.message ?? error),
          });
        }
      }
      this.metrics?.increment('ores_reviewer_reconciliations_total', {
        result: totals.errors ? 'partial' : 'success',
      });
      this.metrics?.increment('ores_reviewer_approvals_total', {}, totals.approved);
      this.logger.info('bound reviewer reconciliation complete', totals);
      return totals;
    } finally {
      this.running = false;
    }
  }
}

export function startReviewerReconciler(reconciler, intervalMs, signal) {
  const timer = setInterval(() => {
    reconciler.runOnce().catch((error) => reconciler.logger.error('bound reviewer reconciliation failed', {
      error: redactText(error?.stack ?? error),
    }));
  }, intervalMs);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return reconciler.runOnce();
}
