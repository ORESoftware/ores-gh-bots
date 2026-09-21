#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECK_NAMES,
  createLogger,
  loadConfig,
  ownerIsAllowed,
  resolveCli,
} from '../../../packages/core/src/index.mjs';
import {
  evaluateMergeCandidate,
  orderMergeCandidates,
  parseMergeReaperDependencies,
  pullRequestKey,
  selectMergeBatch,
  validateMergeReaperPolicy,
} from '../../../packages/engine/src/index.mjs';
import {
  AppAuth,
  checkExternalId,
  countUnresolvedReviewThreads,
  findLatestCheckRun,
  getCiSnapshot,
  getPullRequest,
  GitHubClient,
  listAppInstallations,
  listInstallationRepositories,
  listMergeReaperPullRequestReviews,
  listOpenPullRequests,
  mergePullRequestExact,
} from '../../../packages/github/src/index.mjs';
import { resolveFreshDependencyStates } from './dependency-states.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const modulePath = fileURLToPath(import.meta.url);

function usage() {
  console.error(`Usage:\n  node apps/reaper/src/main.mjs reaper plan\n  node apps/reaper/src/main.mjs reaper apply --confirm MERGE-<ticket>\n`);
}

function normalizePrivateKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('base64:')) return Buffer.from(text.slice(7), 'base64').toString('utf8');
  return text.replace(/\\n/g, '\n');
}

function reaperCredentials(env) {
  const id = String(env.MERGE_REAPER_APP_ID ?? '').trim() || null;
  const privateKey = normalizePrivateKey(env.MERGE_REAPER_APP_PRIVATE_KEY);
  return Object.freeze({ id, privateKey });
}

function parseDependencyKey(key) {
  const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/u.exec(String(key));
  if (!match) throw new Error(`Invalid dependency key: ${key}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function unique(values) {
  return [...new Set(values)];
}

function serializableRepository(repository) {
  return {
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
    private: repository.private,
    installationId: repository.installationId,
  };
}

async function readPolicy(path, overrides) {
  const content = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  return validateMergeReaperPolicy({ ...content, ...overrides });
}

async function discoverRepositories({ client, auth, config, policy }) {
  const repositories = [];
  const installations = await listAppInstallations(client, auth.appJwt('reaper'));
  for (const installation of installations) {
    const token = await auth.installationToken('reaper', installation.id);
    const remaining = policy.maxRepositories - repositories.length;
    if (remaining <= 0) break;
    const installed = await listInstallationRepositories(client, token, remaining);
    for (const repository of installed) {
      if (repository.archived || repository.disabled || !ownerIsAllowed(config, repository.owner?.login)) continue;
      repositories.push({
        owner: repository.owner.login,
        repo: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        private: Boolean(repository.private),
        installationId: installation.id,
      });
      if (repositories.length >= policy.maxRepositories) break;
    }
  }
  return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function trustedPlaceholderSnapshot(pullRequest, gateAppId, gateExternalId, policy) {
  return {
    gateCheck: {
      name: CHECK_NAMES.gate,
      status: 'completed',
      conclusion: 'success',
      head_sha: pullRequest.head?.sha,
      external_id: gateExternalId,
      app: { id: gateAppId },
    },
    ciStates: [{ context: 'merge-reaper/static-preflight', state: 'success' }],
    reviews: policy.requireHumanApproval
      ? [{
        id: 1,
        state: 'APPROVED',
        submitted_at: '1970-01-01T00:00:00.000Z',
        user: { login: 'merge-reaper-static-preflight', type: 'User' },
      }]
      : [],
    unresolvedReviewThreads: 0,
  };
}

async function inspectPullRequest({ client, token, repository, listedPullRequest, policy, gateAppId, now, stackedDependency }) {
  const pullRequest = await getPullRequest(client, token, repository.owner, repository.repo, listedPullRequest.number);
  const key = pullRequestKey(repository.owner, repository.repo, pullRequest.number);
  const dependencies = unique([
    ...parseMergeReaperDependencies(pullRequest.body, repository),
    ...(stackedDependency ? [stackedDependency] : []),
  ]).filter((dependency) => dependency !== key).sort();
  const gateExternalId = checkExternalId('gate', repository.owner, repository.repo, pullRequest.number, pullRequest.head?.sha);
  const staticEvaluation = evaluateMergeCandidate({
    pullRequest,
    policy,
    now,
    expectedGateAppId: gateAppId,
    ...trustedPlaceholderSnapshot(pullRequest, gateAppId, gateExternalId, policy),
  });
  if (!staticEvaluation.eligible) {
    return {
      key,
      repository: repository.fullName.toLowerCase(),
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      createdAt: pullRequest.created_at,
      headSha: pullRequest.head?.sha,
      baseBranch: pullRequest.base?.ref,
      dependencies,
      pullRequest,
      evaluation: staticEvaluation,
      inspection: 'static',
      snapshots: null,
    };
  }

  const [gateCheck, ciStates, reviews, unresolvedReviewThreads] = await Promise.all([
    findLatestCheckRun(client, token, repository.owner, repository.repo, pullRequest.head.sha, CHECK_NAMES.gate, {
      externalId: gateExternalId,
      appId: gateAppId,
    }),
    getCiSnapshot(client, token, repository.owner, repository.repo, pullRequest.head.sha),
    listMergeReaperPullRequestReviews(client, token, repository.owner, repository.repo, pullRequest.number),
    countUnresolvedReviewThreads(client, token, repository.owner, repository.repo, pullRequest.number),
  ]);
  const snapshots = { gateCheck, ciStates, reviews, unresolvedReviewThreads };
  const evaluation = evaluateMergeCandidate({
    pullRequest,
    policy,
    now,
    expectedGateAppId: gateAppId,
    ...snapshots,
  });
  return {
    key,
    repository: repository.fullName.toLowerCase(),
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    createdAt: pullRequest.created_at,
    headSha: pullRequest.head.sha,
    baseBranch: pullRequest.base.ref,
    dependencies,
    pullRequest,
    evaluation,
    inspection: 'full',
    snapshots,
  };
}

async function resolveDependency({ dependency, candidateByKey, auth, client, cache }) {
  if (candidateByKey.has(dependency)) {
    return candidateByKey.get(dependency).evaluation.eligible ? 'eligible-earlier' : 'candidate-blocked';
  }
  if (cache.has(dependency)) return cache.get(dependency);
  const parsed = parseDependencyKey(dependency);
  let state;
  try {
    const { token } = await auth.repoToken('reaper', parsed.owner, parsed.repo);
    const pullRequest = await getPullRequest(client, token, parsed.owner, parsed.repo, parsed.number);
    if (pullRequest.merged === true || pullRequest.merged_at) state = 'merged';
    else if (pullRequest.state === 'open') state = 'open';
    else state = 'closed-unmerged';
  } catch (error) {
    state = `unavailable:${Number(error?.status) || 'error'}`;
  }
  cache.set(dependency, state);
  return state;
}

async function applyDependencyStates({ candidates, auth, client, policy, gateAppId, now }) {
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const dependencyCache = new Map();
  for (const candidate of candidates) {
    if (candidate.inspection !== 'full') continue;
    const dependencyStates = {};
    for (const dependency of candidate.dependencies) {
      dependencyStates[dependency] = await resolveDependency({ dependency, candidateByKey, auth, client, cache: dependencyCache });
    }
    candidate.dependencyStates = dependencyStates;
    candidate.evaluation = evaluateMergeCandidate({
      pullRequest: candidate.pullRequest,
      policy,
      now,
      expectedGateAppId: gateAppId,
      ...candidate.snapshots,
      dependencyStates,
    });
  }
  return { candidateByKey };
}

function publicCandidate(candidate) {
  return {
    key: candidate.key,
    repository: candidate.repository,
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    createdAt: candidate.createdAt,
    headSha: candidate.headSha,
    baseBranch: candidate.baseBranch,
    dependencies: candidate.dependencies,
    dependencyStates: candidate.dependencyStates ?? {},
    inspection: candidate.inspection,
    eligible: candidate.evaluation.eligible,
    reasons: candidate.evaluation.reasons,
    ageHours: candidate.evaluation.ageHours,
    labels: candidate.evaluation.labels,
  };
}

async function freshInspection({ candidate, repository, client, auth, policy, gateAppId }) {
  const token = await auth.installationToken('reaper', repository.installationId);
  const fresh = await inspectPullRequest({
    client,
    token,
    repository,
    listedPullRequest: { number: candidate.number },
    policy,
    gateAppId,
    now: new Date(),
    stackedDependency: null,
  });
  const pulls = await listOpenPullRequests(
    client,
    token,
    repository.owner,
    repository.repo,
    policy.maxPullRequestsPerRepository,
  );
  const stackedBase = pulls.find((pullRequest) => (
    pullRequest.number !== fresh.number && pullRequest.head?.ref === fresh.baseBranch
  ));
  fresh.dependencies = unique([
    ...fresh.dependencies,
    ...(stackedBase ? [pullRequestKey(repository.owner, repository.repo, stackedBase.number)] : []),
  ]).filter((dependency) => dependency !== fresh.key).sort();
  return fresh;
}

async function main() {
  const cli = resolveCli();
  if (cli.help) return cli.printHelp();
  const [group, action] = cli.command.split(' ');
  if (group !== 'reaper' || !['plan', 'apply'].includes(action)) {
    usage();
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(cli.env);
  if (config.github.ownerAllowlist.length === 0 && config.github.ownerPatterns.length === 0) {
    throw new Error('OWNER_ALLOWLIST or OWNER_PATTERNS is required; fleet discovery fails closed');
  }
  const reaper = reaperCredentials(cli.env);
  if (!reaper.id || !reaper.privateKey) {
    throw new Error('MERGE_REAPER_APP_ID and MERGE_REAPER_APP_PRIVATE_KEY are required');
  }
  const gateAppId = Number(config.apps.gate.id);
  if (!Number.isSafeInteger(gateAppId) || gateAppId < 1) throw new Error('GATE_APP_ID must be a positive integer');
  if (String(reaper.id) === String(config.apps.gate.id)) {
    throw new Error('Merge reaper and gate GitHub App identities must be distinct');
  }
  if (action === 'apply' && !/^MERGE-[A-Za-z0-9._-]{1,96}$/u.test(String(cli.values.MERGE_REAPER_CONFIRM ?? ''))) {
    throw new Error('Apply mode requires --confirm MERGE-<change-ticket>');
  }

  const policy = await readPolicy(String(cli.values.MERGE_REAPER_POLICY ?? 'config/merge-reaper.example.json'), {
    minimumAgeHours: cli.values.MERGE_REAPER_MIN_AGE_HOURS,
    maxMerges: cli.values.MERGE_REAPER_MAX_MERGES,
    maxRepositories: cli.values.MERGE_REAPER_MAX_REPOSITORIES,
    maxPullRequestsPerRepository: cli.values.MERGE_REAPER_MAX_PRS_PER_REPOSITORY,
  });
  const logger = createLogger({ service: 'ores-gh-bots-reaper' });
  const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
  const auth = new AppAuth({ client, apps: { ...config.apps, reaper }, logger });
  const now = new Date();
  const repositories = await discoverRepositories({ client, auth, config, policy });
  if (repositories.length === 0) throw new Error('Merge reaper discovered no allowlisted repositories');

  const candidates = [];
  let observedPullRequests = 0;
  for (const repository of repositories) {
    const listToken = await auth.installationToken('reaper', repository.installationId);
    const pulls = await listOpenPullRequests(client, listToken, repository.owner, repository.repo, policy.maxPullRequestsPerRepository);
    observedPullRequests += pulls.length;
    const headBranches = new Map(pulls.map((pullRequest) => [pullRequest.head?.ref, pullRequest]));
    for (const listedPullRequest of pulls) {
      const stackedBase = headBranches.get(listedPullRequest.base?.ref);
      const stackedDependency = stackedBase ? pullRequestKey(repository.owner, repository.repo, stackedBase.number) : null;
      try {
        const token = await auth.installationToken('reaper', repository.installationId);
        candidates.push(await inspectPullRequest({
          client,
          token,
          repository,
          listedPullRequest,
          policy,
          gateAppId,
          now,
          stackedDependency,
        }));
      } catch (error) {
        candidates.push({
          key: pullRequestKey(repository.owner, repository.repo, listedPullRequest.number),
          repository: repository.fullName.toLowerCase(),
          number: listedPullRequest.number,
          title: listedPullRequest.title,
          url: listedPullRequest.html_url,
          createdAt: listedPullRequest.created_at,
          headSha: listedPullRequest.head?.sha,
          baseBranch: listedPullRequest.base?.ref,
          dependencies: [],
          dependencyStates: {},
          inspection: 'failed',
          evaluation: {
            eligible: false,
            reasons: [`inspection-failed:${Number(error?.status) || 'error'}`],
            ageHours: null,
            labels: [],
          },
        });
      }
    }
  }

  const fullCandidates = candidates.filter((candidate) => candidate.inspection === 'full');
  const { candidateByKey } = await applyDependencyStates({ candidates: fullCandidates, auth, client, policy, gateAppId, now });
  const eligibleCandidates = fullCandidates.filter((candidate) => candidate.evaluation.eligible);
  const ordered = orderMergeCandidates(
    eligibleCandidates.map((candidate) => ({
      ...candidate,
      dependencies: candidate.dependencies.filter((dependency) => candidateByKey.has(dependency)),
    })),
    policy.repositoryDependencies,
  );
  const selected = selectMergeBatch(ordered, policy.maxMerges);
  const mergeResults = [];
  const mergedKeys = new Set();

  if (action === 'apply') {
    const repositoryByName = new Map(repositories.map((repository) => [repository.fullName.toLowerCase(), repository]));
    for (const candidate of selected) {
      const unmetInBatch = candidate.dependencies.filter((dependency) => candidateByKey.has(dependency) && !mergedKeys.has(dependency));
      if (unmetInBatch.length > 0) {
        mergeResults.push({ key: candidate.key, merged: false, reason: `dependency-not-merged:${unmetInBatch.join(',')}` });
        continue;
      }
      const repository = repositoryByName.get(candidate.repository);
      try {
        const fresh = await freshInspection({ candidate, repository, client, auth, policy, gateAppId });
        const dependencyCache = new Map();
        const dependencyStates = await resolveFreshDependencyStates({
          freshDependencies: fresh.dependencies,
          mergedKeys,
          resolveLiveDependency: (dependency) => resolveDependency({
            dependency,
            candidateByKey: new Map(),
            auth,
            client,
            cache: dependencyCache,
          }),
        });
        if (fresh.inspection === 'full') {
          fresh.evaluation = evaluateMergeCandidate({
            pullRequest: fresh.pullRequest,
            policy,
            now: new Date(),
            expectedGateAppId: gateAppId,
            ...fresh.snapshots,
            dependencyStates,
          });
        }
        if (!fresh.evaluation.eligible) {
          mergeResults.push({ key: candidate.key, merged: false, reason: `fresh-policy-rejection:${fresh.evaluation.reasons.join(',')}` });
          continue;
        }
        const mergeToken = await auth.installationToken('reaper', repository.installationId);
        const result = await mergePullRequestExact(client, mergeToken, repository.owner, repository.repo, candidate.number, {
          expectedHeadSha: fresh.headSha,
          method: policy.mergeMethod,
          commitTitle: `${fresh.title} (#${fresh.number})`,
          commitMessage: `Merged by the ORES dependency-aware reaper after ${policy.minimumAgeHours}h, exact-SHA ORES gate validation, independent CI success, review-thread resolution, and explicit automerge opt-in.`,
        });
        mergedKeys.add(candidate.key);
        mergeResults.push({ key: candidate.key, merged: true, sha: result.sha ?? null });
      } catch (error) {
        mergeResults.push({ key: candidate.key, merged: false, reason: `merge-failed:${Number(error?.status) || 'error'}` });
      }
    }
  }

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: action,
    policy: {
      minimumAgeHours: policy.minimumAgeHours,
      maxMerges: policy.maxMerges,
      mergeMethod: policy.mergeMethod,
      allowedBaseBranches: policy.allowedBaseBranches,
      requireOptInLabel: policy.requireOptInLabel,
      optInLabels: policy.optInLabels,
      denyLabels: policy.denyLabels,
      requireHumanApproval: policy.requireHumanApproval,
    },
    summary: {
      repositoriesDiscovered: repositories.length,
      pullRequestsObserved: observedPullRequests,
      candidatesInspected: candidates.length,
      eligible: eligibleCandidates.length,
      selected: selected.length,
      merged: mergeResults.filter((result) => result.merged).length,
      failed: mergeResults.filter((result) => !result.merged).length,
    },
    repositories: repositories.map(serializableRepository),
    candidates: candidates.map(publicCandidate),
    mergeOrder: ordered.map((candidate) => candidate.key),
    selected: selected.map((candidate) => candidate.key),
    mergeResults,
  };
  const outputPath = resolve(root, String(cli.values.MERGE_REAPER_OUTPUT ?? 'merge-reaper-report.json'));
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({
    version: report.version,
    generatedAt: report.generatedAt,
    mode: report.mode,
    policy: report.policy,
    summary: report.summary,
    privateMetadataRedacted: true,
  }, null, 2));
  if (action === 'apply' && mergeResults.some((result) => !result.merged)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  try {
    await main();
  } catch (error) {
    console.error(String(error?.message ?? 'merge reaper failed'));
    process.exitCode = 1;
  }
}
