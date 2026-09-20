import {
  CHECK_NAMES,
  applyConsultResult,
  buildReviewAttestations,
  createLogger,
  evaluateGate,
  parsePullRequestDependencies,
  peerConsultPlan,
  peerReviewForPrompt,
  pullRequestDependencyKey,
  redactText,
} from '../../core/src/index.mjs';
import {
  completeFailedCheck,
  completeGateCheck,
  completeReviewCheck,
  completeSupersededGateCheck,
  createPullRequestReview,
  dispatchWorkflow,
  ensureInProgressCheck,
  evaluatePullRequestDependencies,
  getCiSnapshot,
  getCollaboratorPermission,
  getPullRequest,
  listPullRequestFiles,
  permissionCanTriggerReview,
} from '../../github/src/index.mjs';
import { replacePullRequestDependencies } from '../../queue/src/index.mjs';
import { reviewWithAnthropic, reviewWithOpenAI } from '../../providers/src/index.mjs';
import { buildReviewContext } from './context.mjs';
import { loadContractProjectionAdmissions } from './contract-admission-loader.mjs';

function errorSummary(error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactText(message).slice(0, 4_000);
}

function detailsUrl(config, owner, repo, prNumber, headSha) {
  if (!config.github.detailsBaseUrl) return undefined;
  const base = config.github.detailsBaseUrl.replace(/\/$/, '');
  return `${base}/reviews/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${prNumber}/${headSha}`;
}

function summaryBody(reviews, gate, { attest = false } = {}) {
  // Attestations lead the body so the my-ai agent-review-gate can read them
  // from a review anchored to the exact head commit.
  const attestations = attest ? buildReviewAttestations({ headSha: gate.headSha, reviews }) : [];
  const lines = [...attestations, 'ORES dual-AI review result:'];
  for (const provider of ['openai', 'claude']) {
    const review = reviews[provider];
    if (!review) lines.push(`- ${provider}: pending`);
    else if (review.error) lines.push(`- ${provider}: failed — ${review.error}`);
    else lines.push(`- ${provider}: ${review.verdict} (${Math.round(review.confidence * 100)}% confidence)`);
  }
  for (const projection of gate.projectionStates ?? []) {
    lines.push(`- contract ${projection.projectionKind ?? 'invalid'}: ${projection.state} — ${projection.reason}`);
  }
  for (const dependency of gate.dependencyStates ?? []) {
    lines.push(`- dependency ${dependency.dependency ?? 'invalid'}: ${dependency.state} — ${dependency.reason}`);
  }
  lines.push(`- aggregate gate: ${gate.conclusion ?? gate.status}`);
  lines.push('', `Head SHA: \`${gate.headSha}\``);
  return lines.join('\n').slice(0, 65_000);
}

export class ReviewEngine {
  constructor({
    config,
    client,
    auth,
    queue,
    logger = createLogger({ component: 'review-engine' }),
    metrics = null,
    fetchImpl = fetch,
    now = Date.now,
  }) {
    this.config = config;
    this.client = client;
    this.auth = auth;
    this.queue = queue;
    this.logger = logger;
    this.metrics = metrics;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async #orchestratorAccess(job) {
    return this.auth.repoToken('orchestrator', job.owner, job.repo, job.installationId);
  }

  async #loadCurrentPullRequest(job) {
    const access = await this.#orchestratorAccess(job);
    const pullRequest = await getPullRequest(this.client, access.token, job.owner, job.repo, job.prNumber);
    return { access, pullRequest };
  }

  #enqueueCurrent(job, pullRequest, type = job.type, force = false) {
    return this.queue.enqueue({
      ...job,
      id: undefined,
      type,
      headSha: pullRequest.head.sha,
      force,
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

  // One required check per provider and head: the check opens before the
  // independent call and completes once, after any peer consult, so no
  // provisional success is ever published for the required context.
  async #openProviderCheck({ provider, job, pullRequest }) {
    const role = provider === 'openai' ? 'openai' : 'claude';
    const access = await this.auth.repoToken(role, job.owner, job.repo, job.installationId);
    const url = detailsUrl(this.config, job.owner, job.repo, job.prNumber, pullRequest.head.sha);
    const check = await ensureInProgressCheck({
      client: this.client,
      token: access.token,
      owner: job.owner,
      repo: job.repo,
      headSha: pullRequest.head.sha,
      name: CHECK_NAMES[provider],
      detailsUrl: url,
      externalId: `${provider}:${job.owner}/${job.repo}#${job.prNumber}@${pullRequest.head.sha}`,
      summary: `${provider} is reviewing the exact pull-request head SHA ${pullRequest.head.sha}.`,
    });
    return { provider, token: access.token, url, checkRunId: check.id };
  }

  async #callProvider({ provider, context }) {
    try {
      return provider === 'openai'
        ? await reviewWithOpenAI({ config: this.config.providers.openai, context, fetchImpl: this.fetchImpl })
        : await reviewWithAnthropic({ config: this.config.providers.anthropic, context, fetchImpl: this.fetchImpl });
    } catch (error) {
      return { error: errorSummary(error) };
    }
  }

  // Each provider that approved is invoked again with its peer's review. The
  // consult result, including a consult failure, replaces the approval.
  async #consultPeers({ context, reviews }) {
    const plan = peerConsultPlan({ mode: this.config.review.peerConsult, reviews });
    const consulted = await Promise.all(plan.map(async ({ provider, peer }) => {
      this.metrics?.increment('ores_peer_consults_total', { provider, peer });
      const result = await this.#callProvider({
        provider,
        context: { ...context, peerReview: peerReviewForPrompt(peer, reviews[peer]) },
      });
      return [provider, result.error ? result : applyConsultResult({ consulted: result })];
    }));
    return { ...reviews, ...Object.fromEntries(consulted) };
  }

  #recordProviderError({ provider, job, pullRequest, error, checkRunId = null }) {
    const summary = errorSummary(error);
    this.queue.recordReview({
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: pullRequest.head.sha,
      provider,
      error: summary,
      checkRunId,
    });
    return summary;
  }

  async #finishProvider({ opened, job, pullRequest, result }) {
    const { provider, token, url, checkRunId } = opened;
    const target = { client: this.client, token, owner: job.owner, repo: job.repo, checkRunId, name: CHECK_NAMES[provider], detailsUrl: url };
    const { consult: _consult, ...stored } = result;

    if (result.error) {
      this.#recordProviderError({ provider, job, pullRequest, error: result.error, checkRunId });
      await completeFailedCheck({ ...target, summary: result.error }).catch((checkError) => this.logger.error('failed to publish provider failure check', {
        provider,
        error: errorSummary(checkError),
      }));
      this.metrics?.increment('ores_provider_errors_total', { provider });
      return { error: result.error, checkRunId };
    }

    // Success becomes durable/countable only after the exact provider Check Run
    // has reached its terminal success state. If publication fails, overwrite
    // any older same-provider/same-head success with an error before the
    // aggregate gate can read the queue.
    try {
      await completeReviewCheck({ ...target, review: stored });
    } catch (error) {
      const summary = this.#recordProviderError({ provider, job, pullRequest, error, checkRunId });
      await completeFailedCheck({ ...target, summary: `provider review publication failed: ${summary}` }).catch((checkError) => this.logger.error('failed to publish provider failure check after success publication error', {
        provider,
        error: errorSummary(checkError),
      }));
      throw error;
    }

    this.queue.recordReview({
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: pullRequest.head.sha,
      provider,
      result: stored,
      checkRunId,
    });
    this.metrics?.increment('ores_provider_reviews_total', { provider, verdict: result.verdict });
    return { ...result, checkRunId };
  }

  // A provider whose check cannot be opened, completed, or persisted fails
  // closed without taking the other provider's result down with it. When
  // `onError` is supplied, failure invalidation is part of the trust boundary:
  // if it cannot be persisted, abort the whole review before gate publication.
  async #settleProvider(provider, work, onError = null) {
    try {
      return await work();
    } catch (error) {
      const summary = errorSummary(error);
      if (onError) onError(summary);
      this.logger.error('provider review publication failed', { provider, error: summary });
      this.metrics?.increment('ores_provider_errors_total', { provider });
      return { error: summary, checkRunId: null };
    }
  }

  async #dependencyEvidence(job, pullRequest) {
    let declarations;
    try {
      declarations = parsePullRequestDependencies(pullRequest.body, { owner: job.owner, repo: job.repo });
    } catch (error) {
      replacePullRequestDependencies(this.queue, {
        dependentOwner: job.owner,
        dependentRepo: job.repo,
        dependentPrNumber: job.prNumber,
        dependentHeadSha: pullRequest.head.sha,
        dependentInstallationId: job.installationId,
        declarations: [],
      });
      return Object.freeze({
        dependencies: Object.freeze([]),
        ignoredCycles: Object.freeze([]),
        states: Object.freeze([Object.freeze({
          dependency: null,
          state: 'failure',
          reason: `invalid dependency declaration: ${errorSummary(error)}`,
        })]),
      });
    }

    const selected = replacePullRequestDependencies(this.queue, {
      dependentOwner: job.owner,
      dependentRepo: job.repo,
      dependentPrNumber: job.prNumber,
      dependentHeadSha: pullRequest.head.sha,
      dependentInstallationId: job.installationId,
      declarations,
    });
    const verified = await evaluatePullRequestDependencies({
      client: this.client,
      auth: this.auth,
      gateAppId: this.config.apps.gate.id,
      dependencies: selected.accepted,
    });
    const ignoredCycles = Object.freeze(selected.ignored.map((edge) => Object.freeze({
      dependency: pullRequestDependencyKey(edge.dependencyOwner, edge.dependencyRepo, edge.dependencyPrNumber),
      state: 'success',
      reason: 'dependency cycle detected; edge ignored by policy',
      ignored: true,
    })));
    return Object.freeze({
      dependencies: selected.accepted,
      ignoredCycles,
      states: Object.freeze([...verified, ...ignoredCycles]),
    });
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
    const providers = ['openai', 'claude'];
    const invalidateProvider = (provider, checkRunId = null) => (error) => this.#recordProviderError({
      provider,
      job,
      pullRequest,
      error,
      checkRunId,
    });
    const opened = await Promise.all(providers.map((provider) => this.#settleProvider(
      provider,
      () => this.#openProviderCheck({ provider, job, pullRequest }),
      invalidateProvider(provider),
    )));
    const independent = await Promise.all(opened.map((check) => (
      check.error ? check : this.#callProvider({ provider: check.provider, context })
    )));
    const final = await this.#consultPeers({
      context,
      reviews: { openai: independent[0], claude: independent[1] },
    });
    const [openai, claude] = await Promise.all(opened.map((check, index) => (
      check.error ? check : this.#settleProvider(
        providers[index],
        () => this.#finishProvider({ opened: check, job, pullRequest, result: final[providers[index]] }),
        invalidateProvider(providers[index], check.checkRunId ?? null),
      )
    )));

    const latest = await getPullRequest(this.client, access.token, job.owner, job.repo, job.prNumber);
    if (latest.head.sha !== pullRequest.head.sha) {
      this.#enqueueCurrent(job, latest, 'review');
      this.metrics?.increment('ores_stale_reviews_total');
      return { skipped: 'head-moved-during-review', reviewedHeadSha: pullRequest.head.sha, currentHeadSha: latest.head.sha };
    }

    const gate = await this.publishGate({ ...job, headSha: pullRequest.head.sha }, { pullRequest: latest, orchestratorToken: access.token });

    if (this.config.gha.mode === 'supplemental' && this.config.gha.dispatchToken) {
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

    this.queue.invalidateContractAdmissions({
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      currentHeadSha: pullRequest.head.sha,
    });

    const gateAccess = await this.auth.repoToken('gate', job.owner, job.repo, job.installationId);
    const url = detailsUrl(this.config, job.owner, job.repo, job.prNumber, pullRequest.head.sha);
    const gateCheck = await ensureInProgressCheck({
      client: this.client,
      token: gateAccess.token,
      owner: job.owner,
      repo: job.repo,
      headSha: pullRequest.head.sha,
      name: CHECK_NAMES.gate,
      detailsUrl: url,
      externalId: `gate:${job.owner}/${job.repo}#${job.prNumber}@${pullRequest.head.sha}`,
      summary: 'Waiting for exact-SHA AI reviews, configured CI, trusted Contract IR projection evidence, and PR dependencies.',
    });
    const reviews = this.queue.getReviews({
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha: pullRequest.head.sha,
    });
    const ci = await getCiSnapshot(this.client, orchestratorToken, job.owner, job.repo, pullRequest.head.sha);
    const contractAdmission = await loadContractProjectionAdmissions({
      config: this.config,
      client: this.client,
      token: orchestratorToken,
      queue: this.queue,
      logger: this.logger,
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      pullRequest,
      nowMs: this.now(),
    });
    const dependencyEvidence = await this.#dependencyEvidence(job, pullRequest);
    const gateInputs = {
      reviews,
      ci,
      requiredCiContexts: this.config.review.requiredCiContexts,
      requiredCiAppIds: this.config.review.requiredCiAppIds,
      projectionAdmissions: contractAdmission.admissions,
      requiredProjectionKinds: contractAdmission.requiredProjectionKinds,
      projectionContext: contractAdmission.requiredProjectionKinds.length
        ? { repository: `${job.owner}/${job.repo}`, headSha: pullRequest.head.sha }
        : null,
    };
    let evaluated = evaluateGate({ ...gateInputs, dependencyStates: dependencyEvidence.states });

    const latest = await getPullRequest(
      this.client,
      orchestratorToken,
      job.owner,
      job.repo,
      job.prNumber,
    );
    if (latest.head.sha !== pullRequest.head.sha) {
      this.queue.invalidateContractAdmissions({
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        currentHeadSha: latest.head.sha,
      });
      this.#enqueueCurrent(job, latest, 'gate');
      await completeSupersededGateCheck({
        client: this.client,
        token: gateAccess.token,
        owner: job.owner,
        repo: job.repo,
        checkRunId: gateCheck.id,
        reviewedHeadSha: pullRequest.head.sha,
        currentHeadSha: latest.head.sha,
        detailsUrl: url,
      });
      this.metrics?.increment('ores_stale_gate_evaluations_total');
      return {
        skipped: 'head-moved-during-gate',
        evaluatedHeadSha: pullRequest.head.sha,
        currentHeadSha: latest.head.sha,
      };
    }

    if (String(latest.body ?? '') !== String(pullRequest.body ?? '')) {
      this.#enqueueCurrent(job, latest, 'gate', true);
      this.metrics?.increment('ores_stale_gate_evaluations_total', { reason: 'pr-body-moved' });
      return {
        skipped: 'dependency-declarations-changed-during-gate',
        headSha: pullRequest.head.sha,
      };
    }

    if (evaluated.status === 'completed' && evaluated.conclusion === 'success' && dependencyEvidence.dependencies.length > 0) {
      const finalDependencies = await evaluatePullRequestDependencies({
        client: this.client,
        auth: this.auth,
        gateAppId: this.config.apps.gate.id,
        dependencies: dependencyEvidence.dependencies,
      });
      evaluated = evaluateGate({
        ...gateInputs,
        dependencyStates: [...finalDependencies, ...dependencyEvidence.ignoredCycles],
      });
      this.metrics?.increment('ores_pr_dependency_revalidations_total', {
        conclusion: evaluated.conclusion ?? 'pending',
      });
    }

    const gate = { ...evaluated, headSha: pullRequest.head.sha };
    const attest = this.config.review.agentAttestations;
    const publishSummary = async () => {
      if (gate.status !== 'completed' || !this.config.review.postPullRequestReview) return;
      await createPullRequestReview(this.client, orchestratorToken, job.owner, job.repo, job.prNumber, {
        body: summaryBody(reviews, gate, { attest }),
        event: 'COMMENT',
        commitId: pullRequest.head.sha,
      }).catch((error) => {
        // Enabled attestations are part of the gate's contract: the gate check
        // stays in progress and the durable queue retries the job.
        if (attest) throw new Error(`attestation review publication failed: ${errorSummary(error)}`);
        this.logger.warn('failed to post PR review summary', { error: errorSummary(error) });
      });
    };
    if (attest) await publishSummary();
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
    for (const projection of gate.projectionStates ?? []) {
      this.metrics?.increment('ores_contract_admission_evaluations_total', {
        kind: projection.projectionKind ?? 'invalid',
        state: projection.state,
      });
    }
    for (const dependency of gate.dependencyStates ?? []) {
      this.metrics?.increment('ores_pr_dependency_evaluations_total', {
        state: dependency.state,
        ignored: dependency.ignored ? 'true' : 'false',
      });
    }

    if (!attest) await publishSummary();
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
