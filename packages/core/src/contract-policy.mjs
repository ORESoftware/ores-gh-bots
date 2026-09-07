import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OWN_CHECK_NAMES } from './constants.mjs';
import { PROJECTION_KINDS } from './contract-admission/constants.mjs';
import {
  fail,
  parseArtifact,
  requireArray,
  requireBoolean,
  requireExactKeys,
  requireHex160,
  requireNonNegativeInteger,
  requireRepository,
  requireSafePath,
} from './contract-admission/common.mjs';

export const CONTRACT_ADMISSION_POLICY_SCHEMA =
  'ores.gh-bots.contract-admission-policy/v1';
export const DEFAULT_CONTRACT_POLICY_MAX_BYTES = 1024 * 1024;

const MAX_REPOSITORIES = 128;
const MAX_PROJECTIONS_PER_REPOSITORY = 16;
const MAX_PRODUCER_COMMITS = 64;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_CHECK_AGE_SECONDS = 30 * 24 * 60 * 60;
const CHECK_NAME = /^[^\u0000-\u001f\u007f]{1,100}$/u;

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export const EMPTY_CONTRACT_ADMISSION_POLICY = deepFreeze({
  schema: CONTRACT_ADMISSION_POLICY_SCHEMA,
  repositories: [],
});

function requirePositiveInteger(value, code, label, maximum) {
  requireNonNegativeInteger(value, code, label);
  if (value < 1 || value > maximum) {
    fail(code, `${label} must be between 1 and ${maximum}`);
  }
  return value;
}

function requireCheckName(value, label) {
  if (typeof value !== 'string' || !CHECK_NAME.test(value) || value.trim() !== value) {
    fail('invalid_contract_policy', `${label} is invalid`);
  }
  if (OWN_CHECK_NAMES.has(value)) {
    fail('invalid_contract_policy', `${label} cannot reuse an ORES review check identity`);
  }
  return value;
}

function requireCommittedEvidencePath(value, label) {
  requireSafePath(value, 'invalid_contract_policy', label);
  if (value === '.ores' || value.startsWith('.ores/')) {
    fail(
      'invalid_contract_policy',
      `${label} cannot use the reserved, ignored .ores workspace path`,
    );
  }
  return value;
}

function validateProducer(value, label) {
  const producer = requireExactKeys(
    value,
    ['repository', 'allowedCommits', 'checkName', 'checkAppId', 'maxCheckAgeSeconds'],
    new Set(['repository', 'allowedCommits', 'checkName', 'checkAppId', 'maxCheckAgeSeconds']),
    'invalid_contract_policy',
    label,
  );
  requireRepository(producer.repository, 'invalid_contract_policy', `${label}.repository`);
  if (producer.repository !== 'ORESoftware/typespec-json-schema-validator') {
    fail('invalid_contract_policy', `${label}.repository must be the canonical validator repository`);
  }
  const allowedCommits = requireArray(
    producer.allowedCommits,
    'invalid_contract_policy',
    `${label}.allowedCommits`,
  );
  if (allowedCommits.length < 1 || allowedCommits.length > MAX_PRODUCER_COMMITS) {
    fail(
      'invalid_contract_policy',
      `${label}.allowedCommits must contain between 1 and ${MAX_PRODUCER_COMMITS} commits`,
    );
  }
  const normalizedCommits = allowedCommits.map((commit, index) =>
    requireHex160(commit, 'invalid_contract_policy', `${label}.allowedCommits[${index}]`));
  if (new Set(normalizedCommits).size !== normalizedCommits.length) {
    fail('invalid_contract_policy', `${label}.allowedCommits contains duplicates`);
  }
  requireCheckName(producer.checkName, `${label}.checkName`);
  requirePositiveInteger(
    producer.checkAppId,
    'invalid_contract_policy',
    `${label}.checkAppId`,
    Number.MAX_SAFE_INTEGER,
  );
  requirePositiveInteger(
    producer.maxCheckAgeSeconds,
    'invalid_contract_policy',
    `${label}.maxCheckAgeSeconds`,
    MAX_CHECK_AGE_SECONDS,
  );
  if (producer.maxCheckAgeSeconds < 60) {
    fail('invalid_contract_policy', `${label}.maxCheckAgeSeconds must be at least 60`);
  }
  return {
    repository: producer.repository,
    allowedCommits: [...normalizedCommits].sort(),
    checkName: producer.checkName,
    checkAppId: producer.checkAppId,
    maxCheckAgeSeconds: producer.maxCheckAgeSeconds,
  };
}

function validateArtifacts(value, label) {
  const artifacts = requireExactKeys(
    value,
    ['reportPath', 'contractIrPath', 'maxArtifactBytes'],
    new Set(['reportPath', 'contractIrPath', 'maxArtifactBytes']),
    'invalid_contract_policy',
    label,
  );
  requireCommittedEvidencePath(artifacts.reportPath, `${label}.reportPath`);
  requireCommittedEvidencePath(artifacts.contractIrPath, `${label}.contractIrPath`);
  if (artifacts.reportPath === artifacts.contractIrPath) {
    fail('invalid_contract_policy', `${label} report and Contract IR paths must be distinct`);
  }
  requirePositiveInteger(
    artifacts.maxArtifactBytes,
    'invalid_contract_policy',
    `${label}.maxArtifactBytes`,
    MAX_ARTIFACT_BYTES,
  );
  if (artifacts.maxArtifactBytes < 1024) {
    fail('invalid_contract_policy', `${label}.maxArtifactBytes must be at least 1024`);
  }
  return {
    reportPath: artifacts.reportPath,
    contractIrPath: artifacts.contractIrPath,
    maxArtifactBytes: artifacts.maxArtifactBytes,
  };
}

function validateProjections(value, reservedPaths, label) {
  const projections = requireArray(value, 'invalid_contract_policy', label);
  if (projections.length < 1 || projections.length > MAX_PROJECTIONS_PER_REPOSITORY) {
    fail(
      'invalid_contract_policy',
      `${label} must contain between 1 and ${MAX_PROJECTIONS_PER_REPOSITORY} projections`,
    );
  }
  const kinds = new Set();
  const paths = new Set(reservedPaths);
  return projections.map((item, index) => {
    const projectionLabel = `${label}[${index}]`;
    const projection = requireExactKeys(
      item,
      ['kind', 'manifestPath', 'requireCompleteScope'],
      new Set(['kind', 'manifestPath', 'requireCompleteScope']),
      'invalid_contract_policy',
      projectionLabel,
    );
    if (!PROJECTION_KINDS.has(projection.kind)) {
      fail('invalid_contract_policy', `${projectionLabel}.kind is unsupported`);
    }
    if (kinds.has(projection.kind)) {
      fail('invalid_contract_policy', `${label} repeats projection kind ${projection.kind}`);
    }
    kinds.add(projection.kind);
    requireCommittedEvidencePath(projection.manifestPath, `${projectionLabel}.manifestPath`);
    if (paths.has(projection.manifestPath)) {
      fail('invalid_contract_policy', `${projectionLabel}.manifestPath is not unique`);
    }
    paths.add(projection.manifestPath);
    requireBoolean(
      projection.requireCompleteScope,
      'invalid_contract_policy',
      `${projectionLabel}.requireCompleteScope`,
    );
    return {
      kind: projection.kind,
      manifestPath: projection.manifestPath,
      requireCompleteScope: projection.requireCompleteScope,
    };
  }).sort((left, right) => left.kind.localeCompare(right.kind));
}

export function validateContractAdmissionPolicy(value) {
  const policy = requireExactKeys(
    value,
    ['schema', 'repositories'],
    new Set(['schema', 'repositories']),
    'invalid_contract_policy',
    'contractAdmissionPolicy',
  );
  if (policy.schema !== CONTRACT_ADMISSION_POLICY_SCHEMA) {
    fail('invalid_contract_policy_schema', `unsupported contract-admission policy schema ${policy.schema ?? 'none'}`);
  }
  const repositories = requireArray(
    policy.repositories,
    'invalid_contract_policy',
    'contractAdmissionPolicy.repositories',
  );
  if (repositories.length > MAX_REPOSITORIES) {
    fail('invalid_contract_policy', `contractAdmissionPolicy.repositories exceeds ${MAX_REPOSITORIES}`);
  }
  const seenRepositories = new Set();
  const normalized = repositories.map((item, index) => {
    const label = `contractAdmissionPolicy.repositories[${index}]`;
    const repository = requireExactKeys(
      item,
      ['repository', 'enabled', 'producer', 'artifacts', 'projections'],
      new Set(['repository', 'enabled', 'producer', 'artifacts', 'projections']),
      'invalid_contract_policy',
      label,
    );
    requireRepository(repository.repository, 'invalid_contract_policy', `${label}.repository`);
    const repositoryKey = repository.repository.toLowerCase();
    if (seenRepositories.has(repositoryKey)) {
      fail('invalid_contract_policy', `duplicate repository policy for ${repository.repository}`);
    }
    seenRepositories.add(repositoryKey);
    requireBoolean(repository.enabled, 'invalid_contract_policy', `${label}.enabled`);
    const producer = validateProducer(repository.producer, `${label}.producer`);
    const artifacts = validateArtifacts(repository.artifacts, `${label}.artifacts`);
    const projections = validateProjections(
      repository.projections,
      [artifacts.reportPath, artifacts.contractIrPath],
      `${label}.projections`,
    );
    return {
      repository: repository.repository,
      enabled: repository.enabled,
      producer,
      artifacts,
      projections,
    };
  }).sort((left, right) => left.repository.localeCompare(right.repository));
  return deepFreeze({ schema: CONTRACT_ADMISSION_POLICY_SCHEMA, repositories: normalized });
}

export function parseContractAdmissionPolicy(text, maxBytes = DEFAULT_CONTRACT_POLICY_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > DEFAULT_CONTRACT_POLICY_MAX_BYTES) {
    fail('invalid_contract_policy', 'contract-admission policy size limit is invalid');
  }
  return validateContractAdmissionPolicy(
    parseArtifact(text, 'contract-admission policy', maxBytes),
  );
}

export function loadContractAdmissionPolicyFile(path, { lstat = lstatSync, readFile = readFileSync } = {}) {
  if (path === null || path === undefined || path === '') return EMPTY_CONTRACT_ADMISSION_POLICY;
  if (typeof path !== 'string' || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    fail('invalid_contract_policy_path', 'contract-admission policy path is invalid');
  }
  const resolvedPath = resolve(path);
  const stat = lstat(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail('invalid_contract_policy_path', 'contract-admission policy must be one regular, non-linked file');
  }
  if (stat.size < 2 || stat.size > DEFAULT_CONTRACT_POLICY_MAX_BYTES) {
    fail('invalid_contract_policy_path', 'contract-admission policy file size is outside the supported range');
  }
  const bytes = readFile(resolvedPath);
  if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size) {
    fail('invalid_contract_policy_path', 'contract-admission policy file changed while being read');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid_contract_policy_path', 'contract-admission policy must be valid UTF-8');
  }
  return parseContractAdmissionPolicy(text);
}

export function contractAdmissionPolicyForRepository(policy, repository) {
  if (!policy || !Array.isArray(policy.repositories) || typeof repository !== 'string') return null;
  const normalized = repository.toLowerCase();
  return policy.repositories.find((item) => item.enabled && item.repository.toLowerCase() === normalized) ?? null;
}
