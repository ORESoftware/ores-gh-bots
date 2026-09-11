import {
  CHECK_NAMES,
  createLogger,
  evaluateGate,
  redactText,
} from '../../core/src/index.mjs';
import {
  checkExternalId,
  completeFailedCheck,
  completeGateCheck,
  completeReviewCheck,
  createPullRequestReview,
  dispatchWorkflow,
  ensureInProgressCheck,
  getCiSnapshot,
  getCollaboratorPermission,
  getPullRequest,
  listPullRequestFiles,
  permissionCanTriggerReview,
} from '../../github/src/index.mjs';
import { reviewWithAnthropic, reviewWithOpenAI } from '../../providers/src/index.mjs';
import { buildReviewContext } from './context.mjs';

function errorSummary(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactText(message).slice(0, 4_000);
}

function detailsUrl(config, owner, repo, prNumber, headSha) {
  if (!config.github.detailsBaseUrl) return undefined;
  const base = config.github.detailsBaseUrl.replace(/\/$/, '');
  return `${base}/reviews/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${prNumber}/${headSha}`;
}

function summaryBody(reviews, gate) {
  const lines = ['ORES dual-AI review result:'];
  for (const provider of ['openai', 'claude']) {
    const review = reviews[provider];
    if (!review) lines.push(`- ${provider}: pending`);
    else if (review.error) lines.push(`- ${provider}: failed — ${review.error}`);
    else lines.push(`- ${provider}: ${review.verdict} (${Math.round(review.confidence * 100)}% confidence)`);
  }
  lines.push(`- aggregate gate: ${gate.conclusion ?? gate.status}`);
  lines.push('', `Head SHA: \`${gate.headSha}\``);
  return lines.join('\n').slice(0, 65_000);
}

export class ReviewEngine {
  constructor({ config, client, auth, queue, logger = createLogger({ component: 'review-engine' }), metrics = null, fetchImpl = fetch }) {
    this.config = config;
    this.client = client;
    this.auth = auth;
    this.queue = queue;
    this.logger = logger;
    this.metrics = metrics;
    this.fetchImpl = fetchImpl;
  }

  async #orchestratorAccess(job) {
    return this.auth.repoToken('orchestrator', job.owner, job.repo, job.installationId);
  }

  async #loadCurrentPullRequest(job) {
    const access = await this.#orchestratorAccess(job);
    const pullRequest = await getPullRequest(this.client, access.token, job.owner, job.repo, job.prNumber);
    return { access, pullRequest };
  }

  #enqueueCurrent(job, pullRequest, type = job.type) {
    return this.queue.enqueue({
      ...job,
      id: undefined,
      type,
      headSha: pullRequest.head.sha,
      force: false,
      needsAuthorization: false,
      reason: `${job.reason}:head-moved`,
    });
  }

  async #authorizeCommand(job, token) {
    if (!job.needsAuthorization) return true;
    if (!job.sender) return false;
    try {
      const permission = await getCollaboratorPermission(this.client, token, job.owner, job.repo, job.sender);
      return permissionCanTriggerReview(permission);
    } catch (error) {
      this.logger.warn('manual review command authorization failed', {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        sender: job.sender,
        error: errorSummary(error),
      });
      return false;
    }
  }

  async #dispatchOffload(job, pullRequest) {
    let dispatchToken = this.config.gha.dispatchToken;
    if (!dispatchToken) {
      const [dispatchOwner, dispatchRepo] = this.config.gha.repository.split('/');
      if (!dispatchOwner || !dispatchRepo) throw new Error(`Invalid GHA repository: ${this.config.gha.repository}`);
      const access = await this.auth.repoToken('actions', dispatchOwner, dispatchRepo, this.config.gha.installationId || null);
      dispatchToken = access.token;
    }
    await dispatchWorkflow(
      this.client,
      dispatchToken,
      this.config.gha.repository,
      this.config.gha.workflowId,
      this.config.gha.ref,
      {
        owner: job.owner,
        repo: job.repo,
        pr_number: job.prNumber,
        head_sha: pullRequest.head.sha,
        installation_id: job.installationId,
        reason: job.reason,
      },
    );
    this.metrics?.increment('ores_review_offload_dispatched_total');
    return { offloaded: true, headSha: pullRequest.head.sha };
  }

  async #runProvider({ provider, job, pullRequest, context }) {
    const role = provider === 'openai' ? 'openai' : 'claude';
    const checkName = CHECK_NAMES[provider];
    const access = await this.auth.repoToken(role, job.owner, job.repo);
    const url = detailsUrl(this.config, job.owner, job.repo, job.prNumber, pullRequest.head.sha);
    const check = await ensureInProgressCheck({
      client: this.client,
      token: access.token,
      owner: job.owner,
      repo: job.repo,
      headSha: pullRequest.head.sha,
      name: checkName,
      detailsUrl: url,
      externalId: checkExternalId(provider, job.owner, job.repo, job.prNumber, pullRequest.head.sha),
      expectedAppId: this.config.apps[role].id,
      summary: `${provider} is reviewing the exact pull-request head SHA ${pullRequest.head.sha}.`,
    });

    try {
      const result = provider === 'openai'
        ? await reviewWithOpenAI({ config: this.config.providers.openai, context, fetchImpl: this.fetchImpl })
        : await reviewWithAnthropic({ config: this.config.providers.anthropic, context, fetchImpl: this.fetchImpl });
      this.queue.recordReview({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: pullRequest.head.sha,
        provider,
        result,
        checkRunId: check.id,
      });
      await completeReviewCheck({
        client: this.client,
        token: access.token,
        owner: job.owner,
        repo: job.repo,
        checkRunId: check.id,
        name: checkName,
        review: result,
        detailsUrl: url,
      });
      this.metrics?.increment('ores_provider_reviews_total', { provider, verdict: result.verdict });
      return { ...result, checkRunId: check.id };
    } catch (error) {
      const summary = errorSummary(error);
      this.queue.recordReview({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha: pullRequest.head.sha,
        provider,
        error: summary,
        checkRunId: check.id,
      });
      await completeFailedCheck({
        client: this.client,
        token: access.token,
        owner: job.owner,
        repo: job.repo,
        checkRunId: check.id,
        name: checkName,
        summary,
        detailsUrl: url,
      }).catch((checkError) => this.logger.error('failed to publish provider failure check', {
        provider,
        error: errorSummary(checkError),
      }));
      this.metrics?.increment('ores_provider_errors_total', { provider });
      return { error: summary, checkRunId: check.id };
    }
  }

  async review(job) {
    const { access, pullRequest } = await this.#loadCurrentPullRequest(job);
    if (!(await this.#authorizeCommand(job, access.token))) {
      this.metrics?.increment('ores_review_commands_rejected_total');
      return { skipped: 'unauthorized-command' };
    }
    if (pullRequest.state !== 'open') return { skipped: `pull-request-${pullRequest.state}` };
    if (pullRequest.draft) return { skipped: 'draft-pull-request' };
    if (job.headSha && job.headSha !== pullRequest.head.sha) {
      this.#enqueueCurrent(job, pullRequest, 'review');
      return { skipped: 'stale-head', currentHeadSha: pullRequest.head.sha };
    }
    if (this.config.gha.mode === 'offload') return this.#dispatchOffload(job, pullRequest);

    const files = await listPullRequestFiles(this.client, access.token, job.owner, job.repo, job.prNumber);
    const context = buildReviewContext({ pullRequest, files, reviewConfig: this.config.review });
    const [openai, claude] = await Promise.all([
      this.#runProvider({ provider: 'openai', job, pullRequest, context }),
      this.#runProvider({ provider: 'claude', job, pullRequest, context }),
    ]);

    const latest = await getPullRequest(this.client, access.token, job.owner, job.repo, job.prNumber);
    if (latest.head.sha !== pullRequest.head.sha) {
      this.#enqueueCurrent(job, latest, 'review');
      this.metrics?.increment('ores_stale_reviews_total');
      return { skipped: 'head-moved-during-review', reviewedHeadSha: pullRequest.head.sha, currentHeadSha: latest.head.sha };
    }

    const gate = await this.publishGate({ ...job, headSha: pullRequest.head.sha }, { pullRequest: latest, orchestratorToken: access.token });

    const supplementalDispatchConfigured = Boolean(
      this.config.gha.dispatchToken
      || (this.config.apps.actions.id && this.config.apps.actions.privateKey),
    );
    if (this.config.gha.mode === 'supplemental' && supplementalDispatchConfigured) {
      await this.#dispatchOffload(job, pullRequest).catch((error) => {
        this.logger.warn('supplemental GHA dispatch failed', { error: errorSummary(error) });
      });
    }
    return { headSha: pullRequest.head.sha, openai, claude, gate };
  }

  async publishGate(job, preloaded = null) {
    const loaded = preloaded ?? await this.#loadCurrentPullRequest(job);
    const pullRequest = loaded.pullRequest;
    const orchestratorToken = loaded.orchestratorToken ?? loaded.access?.token;
    if (pullRequest.state !== 'open') return { skipped: `pull-request-${pullRequest.state}` };
    if (job.headSha && job.headSha !== pullRequest.head.sha) {
      this.#enqueueCurrent(job, pullRequest, 'gate');
      return { skipped: 'stale-head', currentHeadSha: pullRequest.head.sha };
    }

    const gateAccess = await this.auth.repoToken('gate', job.owner, job.repo);
    const url = detailsUrl(this.config, job.owner, job.repo, job.prNumber, pullRequest.head.sha);
    const gateCheck = await ensureInProgressCheck({
      client: this.client,
      token: gateAccess.token,
      owner: job.owner,
      repo: job.repo,
      headSha: pullRequest.head.sha,
      name: CHECK_NAMES.gate,
      detailsUrl: url,
      externalId: checkExternalId('gate', job.owner, job.repo, job.prNumber, pullRequest.head.sha),
      expectedAppId: this.config.apps.gate.id,
      summary: 'Waiting for both exact-SHA AI reviews and all configured CI contexts.',
    });
    const reviews = this.queue.getReviews({
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: pullRequest.head.sha,
    });
    const ci = await getCiSnapshot(this.client, orchestratorToken, job.owner, job.repo, pullRequest.head.sha);
    const evaluated = evaluateGate({
      reviews,
      ci,
      requiredCiContexts: this.config.review.requiredCiContexts,
      requiredCiAppIds: this.config.review.requiredCiAppIds,
    });
    const gate = { ...evaluated, headSha: pullRequest.head.sha };
    await completeGateCheck({
      client: this.client,
      token: gateAccess.token,
      owner: job.owner,
      repo: job.repo,
      checkRunId: gateCheck.id,
      gate,
      detailsUrl: url,
    });
    this.metrics?.increment('ores_gate_evaluations_total', {
      status: gate.status,
      conclusion: gate.conclusion ?? 'pending',
    });

    if (gate.status === 'completed' && this.config.review.postPullRequestReview) {
      await createPullRequestReview(this.client, orchestratorToken, job.owner, job.repo, job.prNumber, {
        body: summaryBody(reviews, gate),
        event: 'COMMENT',
        commitId: pullRequest.head.sha,
      }).catch((error) => this.logger.warn('failed to post PR review summary', { error: errorSummary(error) }));
    }
    return gate;
  }

  async process(job) {
    const logger = this.logger.child({
      jobId: job.id,
      type: job.type,
      repository: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      headSha: job.headSha,
    });
    logger.info('processing job', { reason: job.reason, attempt: job.attempts });
    const result = job.type === 'gate' ? await this.publishGate(job) : await this.review(job);
    logger.info('job processed', { result });
    return result;
  }
}
