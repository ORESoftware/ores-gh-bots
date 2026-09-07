const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;
const HEX_160 = /^[a-f0-9]{40}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export class ContractArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractArtifactError';
    this.code = code;
  }
}

function artifactError(code, message) {
  throw new ContractArtifactError(code, message);
}

function assertRepositoryPart(value, label) {
  if (typeof value !== 'string' || !REPOSITORY_PART.test(value)) {
    artifactError('contract_artifact_repository_invalid', `${label} is invalid`);
  }
}

function assertHeadSha(value) {
  if (typeof value !== 'string' || !HEX_160.test(value)) {
    artifactError('contract_artifact_head_invalid', 'headSha must be a full lowercase Git commit SHA');
  }
}

function assertSafePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    artifactError('contract_artifact_path_invalid', 'artifact path must be a bounded relative path');
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    artifactError('contract_artifact_path_invalid', 'artifact path must be normalized and relative');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    artifactError('contract_artifact_path_invalid', 'artifact path contains an unsafe segment');
  }
  return value;
}

function assertMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_ARTIFACT_BYTES) {
    artifactError(
      'contract_artifact_limit_invalid',
      `maxBytes must be between 2 and ${MAX_ARTIFACT_BYTES}`,
    );
  }
}

function encodeRepositoryPath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function decodeBase64(content, expectedSize, path) {
  const normalized = content.replace(/[\r\n\t ]/gu, '');
  if (!BASE64.test(normalized)) {
    artifactError('contract_artifact_base64_invalid', `artifact ${path} has invalid base64 content`);
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length !== expectedSize) {
    artifactError(
      'contract_artifact_size_mismatch',
      `artifact ${path} byte length does not match GitHub metadata`,
    );
  }
  return bytes;
}

async function loadArtifactBytes(client, token, owner, repo, artifact, path) {
  if (artifact.encoding === 'base64' && typeof artifact.content === 'string') {
    return decodeBase64(artifact.content, artifact.size, path);
  }
  if (artifact.encoding !== 'none' && artifact.encoding !== null && artifact.encoding !== undefined) {
    artifactError(
      'contract_artifact_encoding_invalid',
      `artifact ${path} has unsupported inline encoding`,
    );
  }

  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${artifact.sha}`,
    { token },
  );
  const blob = response.data;
  if (!blob || Array.isArray(blob) || blob.sha !== artifact.sha) {
    artifactError(
      'contract_artifact_blob_mismatch',
      `artifact ${path} Git blob identity is mismatched`,
    );
  }
  if (!Number.isSafeInteger(blob.size) || blob.size !== artifact.size) {
    artifactError(
      'contract_artifact_blob_size_mismatch',
      `artifact ${path} Git blob size is mismatched`,
    );
  }
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    artifactError(
      'contract_artifact_blob_encoding_invalid',
      `artifact ${path} Git blob is not base64 encoded`,
    );
  }
  return decodeBase64(blob.content, artifact.size, path);
}

export async function fetchRepositoryTextFileAtCommit(
  client,
  token,
  owner,
  repo,
  path,
  headSha,
  { maxBytes },
) {
  assertRepositoryPart(owner, 'owner');
  assertRepositoryPart(repo, 'repo');
  assertSafePath(path);
  assertHeadSha(headSha);
  assertMaxBytes(maxBytes);
  const encodedPath = encodeRepositoryPath(path);
  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`,
    { token },
  );
  const artifact = response.data;
  if (!artifact || Array.isArray(artifact) || artifact.type !== 'file') {
    artifactError(
      'contract_artifact_not_file',
      `artifact ${path} is not one regular repository file`,
    );
  }
  if (artifact.path !== path) {
    artifactError(
      'contract_artifact_path_mismatch',
      `artifact ${path} response path is mismatched`,
    );
  }
  if (!HEX_160.test(artifact.sha ?? '')) {
    artifactError(
      'contract_artifact_blob_missing',
      `artifact ${path} is missing an immutable Git blob SHA`,
    );
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 2 || artifact.size > maxBytes) {
    artifactError(
      'contract_artifact_size_invalid',
      `artifact ${path} exceeds the configured byte boundary`,
    );
  }
  const bytes = await loadArtifactBytes(client, token, owner, repo, artifact, path);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return artifactError(
      'contract_artifact_utf8_invalid',
      `artifact ${path} is not valid UTF-8`,
    );
  }
  return Object.freeze({
    path,
    blobSha: artifact.sha,
    size: artifact.size,
    text,
  });
}

function checkFailure(code, reason, metadata = {}) {
  return Object.freeze({
    state: 'failure',
    code,
    reason,
    checkRunId: metadata.checkRunId ?? null,
    completedAt: metadata.completedAt ?? null,
    expiresAt: metadata.expiresAt ?? null,
  });
}

function checkPending(code, reason, metadata = {}) {
  return Object.freeze({
    state: 'pending',
    code,
    reason,
    checkRunId: metadata.checkRunId ?? null,
    completedAt: null,
    expiresAt: null,
  });
}

export async function inspectProjectionProducerCheck(
  client,
  token,
  owner,
  repo,
  headSha,
  { checkName, checkAppId, maxCheckAgeSeconds, nowMs = Date.now() },
) {
  assertRepositoryPart(owner, 'owner');
  assertRepositoryPart(repo, 'repo');
  assertHeadSha(headSha);
  if (typeof checkName !== 'string' || checkName.length < 1 || checkName.length > 100) {
    artifactError('producer_check_policy_invalid', 'checkName is invalid');
  }
  if (!Number.isSafeInteger(checkAppId) || checkAppId < 1) {
    artifactError('producer_check_policy_invalid', 'checkAppId is invalid');
  }
  if (!Number.isSafeInteger(maxCheckAgeSeconds) || maxCheckAgeSeconds < 60) {
    artifactError('producer_check_policy_invalid', 'maxCheckAgeSeconds is invalid');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    artifactError('producer_check_policy_invalid', 'nowMs is invalid');
  }

  const response = await client.request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`,
    { token },
  );
  const namedChecks = (response.data?.check_runs ?? [])
    .filter((check) => check?.name === checkName)
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
  if (namedChecks.length === 0) {
    return checkPending('producer_check_missing', `required producer check ${checkName} is missing`);
  }
  const ownedChecks = namedChecks.filter((check) => Number(check.app?.id) === checkAppId);
  if (ownedChecks.length === 0) {
    return checkFailure(
      'producer_check_identity_mismatch',
      `producer check ${checkName} was not published by configured App ${checkAppId}`,
    );
  }
  const check = ownedChecks[0];
  const checkRunId = Number(check.id);
  if (!Number.isSafeInteger(checkRunId) || checkRunId < 1) {
    return checkFailure('producer_check_invalid', 'producer check run id is invalid');
  }
  if (check.head_sha !== headSha) {
    return checkFailure(
      'producer_check_head_mismatch',
      'producer check is not bound to the current pull-request head',
      { checkRunId },
    );
  }
  if (check.status !== 'completed') {
    return checkPending(
      'producer_check_pending',
      `producer check ${checkName} is ${check.status ?? 'pending'}`,
      { checkRunId },
    );
  }
  if (check.conclusion !== 'success') {
    return checkFailure(
      'producer_check_not_successful',
      `producer check ${checkName} concluded ${check.conclusion ?? 'without a conclusion'}`,
      { checkRunId },
    );
  }
  const completedAtMs = Date.parse(check.completed_at ?? '');
  if (!Number.isFinite(completedAtMs)) {
    return checkFailure(
      'producer_check_invalid_time',
      'producer check completion time is missing or invalid',
      { checkRunId },
    );
  }
  if (completedAtMs > nowMs + 5 * 60_000) {
    return checkFailure(
      'producer_check_invalid_time',
      'producer check completion time is implausibly in the future',
      { checkRunId, completedAt: completedAtMs },
    );
  }
  const expiresAt = completedAtMs + maxCheckAgeSeconds * 1000;
  if (nowMs >= expiresAt) {
    return checkFailure(
      'producer_check_expired',
      `producer check ${checkName} is older than the configured evidence window`,
      { checkRunId, completedAt: completedAtMs, expiresAt },
    );
  }
  return Object.freeze({
    state: 'success',
    code: 'producer_check_admitted',
    reason: `producer check ${checkName} is successful and App-owned`,
    checkRunId,
    completedAt: completedAtMs,
    expiresAt,
  });
}
