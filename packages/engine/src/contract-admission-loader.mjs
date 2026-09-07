import {
  contractAdmissionPolicyForRepository,
  createContractProjectionAdmissionFailure,
  parseContractProjectionAdmissionManifestText,
  redactText,
  verifyContractProjectionAdmission,
} from '../../core/src/index.mjs';
import {
  fetchRepositoryTextFileAtCommit,
  inspectProjectionProducerCheck,
} from '../../github/src/index.mjs';

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,127}$/u;
const HEX_160 = /^[a-f0-9]{40}$/u;

function freezeResult(value) {
  return Object.freeze({
    policyMatched: value.policyMatched,
    requiredProjectionKinds: Object.freeze([...value.requiredProjectionKinds]),
    admissions: Object.freeze([...value.admissions]),
    producerCheck: value.producerCheck ? Object.freeze({ ...value.producerCheck }) : null,
  });
}

function boundedError(error) {
  const status = Number(error?.status ?? error?.response?.status ?? 0);
  if (TRANSIENT_STATUSES.has(status)) return null;
  const explicitCode = typeof error?.code === 'string' && FAILURE_CODE.test(error.code)
    ? error.code
    : null;
  if (status === 0 && explicitCode === null) {
    // Fetch/network exceptions generally have no HTTP status. Keep them in the
    // queue retry path rather than converting a temporary transport outage into
    // a durable contract rejection.
    return null;
  }
  let code = explicitCode ?? 'contract_artifact_http_error';
  if (status === 403) code = 'contract_artifact_access_denied';
  if (status === 404) code = 'contract_artifact_missing';
  if (status === 422) code = 'contract_artifact_reference_invalid';
  const message = redactText(error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, 1_000);
  return {
    code,
    message: message || 'contract artifact validation failed',
  };
}

function createFailure({ repository, headSha, projectionKind, code, message }) {
  return createContractProjectionAdmissionFailure({
    repository,
    headSha,
    projectionKind,
    code,
    message,
  });
}

function persistAdmission(queue, context, policy, projectionKind, producerCheck, result, expiresAt) {
  return queue.recordContractAdmission({
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
    headSha: context.headSha,
    projectionKind,
    result,
    producerCheckRunId: producerCheck?.checkRunId ?? null,
    producerCheckName: policy.producer.checkName,
    producerAppId: policy.producer.checkAppId,
    expiresAt,
  });
}

function persistFailures(queue, context, policy, producerCheck, failures, expiresAt) {
  for (const failure of failures) {
    persistAdmission(
      queue,
      context,
      policy,
      failure.projectionKind,
      producerCheck,
      failure,
      expiresAt,
    );
  }
}

function logFailure(logger, context, result) {
  logger?.warn?.('contract projection admission rejected', {
    repository: context.repository,
    prNumber: context.prNumber,
    headSha: context.headSha,
    projectionKind: result.projectionKind,
    code: result.findings?.[0]?.code ?? 'contract_admission_failed',
  });
}

function failuresForPolicy(context, policy, code, message) {
  return policy.projections.map((projection) => createFailure({
    repository: context.repository,
    headSha: context.headSha,
    projectionKind: projection.kind,
    code,
    message,
  }));
}

function returnFailures({ queue, logger, context, policy, producerCheck, code, message, expiresAt }) {
  const failures = failuresForPolicy(context, policy, code, message);
  persistFailures(queue, context, policy, producerCheck, failures, expiresAt);
  failures.forEach((failure) => logFailure(logger, context, failure));
  return freezeResult({
    policyMatched: true,
    requiredProjectionKinds: policy.projections.map((projection) => projection.kind),
    admissions: failures,
    producerCheck,
  });
}

async function fetchSharedArtifacts({ client, token, context, policy }) {
  const options = { maxBytes: policy.artifacts.maxArtifactBytes };
  const [report, contractIr] = await Promise.all([
    fetchRepositoryTextFileAtCommit(
      client,
      token,
      context.owner,
      context.repo,
      policy.artifacts.reportPath,
      context.headSha,
      options,
    ),
    fetchRepositoryTextFileAtCommit(
      client,
      token,
      context.owner,
      context.repo,
      policy.artifacts.contractIrPath,
      context.headSha,
      options,
    ),
  ]);
  return { report, contractIr };
}

/**
 * Load and verify the exact evidence required by one trusted repository policy.
 * Pull-request content never selects paths, producer identities, producer
 * commits, projection kinds, or evidence freshness.
 */
export async function loadContractProjectionAdmissions({
  config,
  client,
  token,
  queue,
  logger,
  owner,
  repo,
  prNumber,
  pullRequest,
  nowMs = Date.now(),
}) {
  const repository = `${owner}/${repo}`;
  const policy = contractAdmissionPolicyForRepository(
    config.contractAdmission?.policy,
    repository,
  );
  if (!policy) {
    return freezeResult({
      policyMatched: false,
      requiredProjectionKinds: [],
      admissions: [],
      producerCheck: null,
    });
  }

  const headSha = pullRequest?.head?.sha;
  if (!HEX_160.test(headSha ?? '')) {
    throw new Error('GitHub pull request head SHA is missing or invalid');
  }
  const context = { owner, repo, repository, prNumber, headSha };
  queue.invalidateContractAdmissions({
    owner,
    repo,
    prNumber,
    currentHeadSha: headSha,
  });
  const requiredProjectionKinds = policy.projections.map((projection) => projection.kind);
  const headRepository = pullRequest?.head?.repo?.full_name;
  if (typeof headRepository !== 'string') {
    return returnFailures({
      queue,
      logger,
      context,
      policy,
      producerCheck: null,
      code: 'contract_artifact_head_repository_missing',
      message: 'pull-request head repository is unavailable for exact artifact binding',
      expiresAt: nowMs + 5 * 60_000,
    });
  }
  if (headRepository.toLowerCase() !== repository.toLowerCase()) {
    return returnFailures({
      queue,
      logger,
      context,
      policy,
      producerCheck: null,
      code: 'contract_artifact_fork_unsupported',
      message: 'contract evidence must be read from a same-repository exact head',
      expiresAt: nowMs + 5 * 60_000,
    });
  }

  const producerCheck = await inspectProjectionProducerCheck(
    client,
    token,
    owner,
    repo,
    headSha,
    {
      checkName: policy.producer.checkName,
      checkAppId: policy.producer.checkAppId,
      maxCheckAgeSeconds: policy.producer.maxCheckAgeSeconds,
      nowMs,
    },
  );
  if (producerCheck.state === 'pending') {
    return freezeResult({
      policyMatched: true,
      requiredProjectionKinds,
      admissions: [],
      producerCheck,
    });
  }
  if (producerCheck.state === 'failure') {
    return returnFailures({
      queue,
      logger,
      context,
      policy,
      producerCheck,
      code: producerCheck.code,
      message: producerCheck.reason,
      expiresAt: producerCheck.expiresAt ?? nowMs + 5 * 60_000,
    });
  }

  const reconciliationWindowMs = Math.max(
    60_000,
    Number(config.reconciliation?.intervalMs ?? 10 * 60_000),
  );
  if (producerCheck.expiresAt - nowMs <= reconciliationWindowMs) {
    return returnFailures({
      queue,
      logger,
      context,
      policy,
      producerCheck,
      code: 'producer_check_expiring',
      message: 'producer check does not remain valid through the next reconciliation window',
      expiresAt: producerCheck.expiresAt,
    });
  }

  let shared;
  try {
    shared = await fetchSharedArtifacts({ client, token, context, policy });
  } catch (error) {
    const failure = boundedError(error);
    if (!failure) throw error;
    return returnFailures({
      queue,
      logger,
      context,
      policy,
      producerCheck,
      code: failure.code,
      message: failure.message,
      expiresAt: producerCheck.expiresAt,
    });
  }

  const admissions = [];
  for (const projection of policy.projections) {
    let result;
    try {
      const manifestArtifact = await fetchRepositoryTextFileAtCommit(
        client,
        token,
        owner,
        repo,
        projection.manifestPath,
        headSha,
        { maxBytes: policy.artifacts.maxArtifactBytes },
      );
      const manifest = parseContractProjectionAdmissionManifestText(
        manifestArtifact.text,
        policy.artifacts.maxArtifactBytes,
      );
      if (manifest?.projection?.kind !== projection.kind) {
        result = createFailure({
          repository,
          headSha,
          projectionKind: projection.kind,
          code: 'projection_kind_mismatch',
          message: `manifest projection kind does not match trusted policy kind ${projection.kind}`,
        });
      } else {
        result = verifyContractProjectionAdmission({
          manifest,
          reportText: shared.report.text,
          contractIrText: shared.contractIr.text,
          expectedRepository: repository,
          expectedHeadSha: headSha,
          allowedProducerCommits: policy.producer.allowedCommits,
          requireCompleteScope: projection.requireCompleteScope,
          maxArtifactBytes: policy.artifacts.maxArtifactBytes,
        });
      }
    } catch (error) {
      const failure = boundedError(error);
      if (!failure) throw error;
      result = createFailure({
        repository,
        headSha,
        projectionKind: projection.kind,
        code: failure.code,
        message: failure.message,
      });
    }
    persistAdmission(
      queue,
      context,
      policy,
      projection.kind,
      producerCheck,
      result,
      producerCheck.expiresAt,
    );
    if (!result.admissible) logFailure(logger, context, result);
    admissions.push(result);
  }

  return freezeResult({
    policyMatched: true,
    requiredProjectionKinds,
    admissions,
    producerCheck,
  });
}
