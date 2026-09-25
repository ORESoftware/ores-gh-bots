import { GitHubHttpError } from './client.mjs';
import { getRepositoryTextFile } from './hardening.mjs';
import {
  applyFleetHardeningPlan as applyFleetHardeningPlanUnchecked,
  branchForFleetHardeningPlan,
  buildFleetHardeningPlan,
  canonicalFleetHardeningJson,
  fleetHardeningDigest,
  fleetHardeningPlanDigest,
  repositoryInHardeningScope,
  validateFleetHardeningCanaryReceipt,
  validateFleetHardeningPlan,
} from './fleet-hardening-plan.mjs';

export {
  branchForFleetHardeningPlan,
  buildFleetHardeningPlan,
  canonicalFleetHardeningJson,
  fleetHardeningDigest,
  fleetHardeningPlanDigest,
  repositoryInHardeningScope,
  validateFleetHardeningCanaryReceipt,
  validateFleetHardeningPlan,
};

function canonicalText(value) {
  return `${String(value).replace(/\r\n/gu, '\n').replace(/\s+$/u, '')}\n`;
}

function groupByRepository(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const key = operation.repository;
    const existing = groups.get(key) ?? {
      repository: key,
      owner: operation.owner,
      repo: operation.repo,
      expectedHead: operation.expectedHead,
      paths: new Set(),
      operations: [],
    };
    if (existing.expectedHead !== operation.expectedHead) {
      throw new Error(`Plan contains inconsistent base identity for ${key}`);
    }
    existing.paths.add(operation.path);
    existing.operations.push(operation);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((left, right) => left.repository.localeCompare(right.repository));
}

async function existingBranchSha(client, token, group, branch) {
  try {
    const response = await client.request(
      'GET',
      `/repos/${encodeURIComponent(group.owner)}/${encodeURIComponent(group.repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      { token },
    );
    return String(response.data?.object?.sha ?? '');
  } catch (error) {
    if (error instanceof GitHubHttpError && error.status === 404) return null;
    throw error;
  }
}

async function assertBranchIsExactPlan(client, tokenForRepository, validated, branch, { requireExisting = false } = {}) {
  for (const group of groupByRepository(validated.operations)) {
    const token = await tokenForRepository(group.owner, group.repo);
    const branchSha = await existingBranchSha(client, token, group, branch);
    if (!branchSha) {
      if (requireExisting) throw new Error(`${group.repository} proposal branch disappeared before final admission`);
      continue;
    }

    const response = await client.request(
      'GET',
      `/repos/${encodeURIComponent(group.owner)}/${encodeURIComponent(group.repo)}/compare/${encodeURIComponent(group.expectedHead)}...${encodeURIComponent(branch)}`,
      { token },
    );
    const files = Array.isArray(response.data?.files) ? response.data.files : null;
    if (!files) throw new Error(`${group.repository} proposal diff could not be verified`);
    const changed = new Set(files.map((file) => String(file?.filename ?? '')).filter(Boolean));
    if (changed.size !== group.paths.size || [...changed].some((path) => !group.paths.has(path))) {
      throw new Error(`${group.repository} proposal branch contains changes outside the reviewed plan`);
    }

    for (const operation of group.operations) {
      const file = await getRepositoryTextFile(client, token, {
        owner: group.owner,
        repo: group.repo,
        path: operation.path,
        ref: branch,
      });
      if (!file || canonicalText(file.content) !== canonicalText(operation.content)) {
        throw new Error(`${group.repository}:${operation.path} does not match the reviewed plan`);
      }
    }
  }
}

export async function applyFleetHardeningPlan(client, tokenForRepository, validated, options = {}) {
  const planDigest = String(options.planDigest ?? '');
  const expected = fleetHardeningPlanDigest(validated?.plan);
  if (planDigest !== expected) {
    throw new Error('Apply plan digest does not match the validated reviewed plan');
  }
  const branch = branchForFleetHardeningPlan(planDigest);
  await assertBranchIsExactPlan(client, tokenForRepository, validated, branch);
  const result = await applyFleetHardeningPlanUnchecked(client, tokenForRepository, validated, options);
  if (!result.ok) return result;

  try {
    await assertBranchIsExactPlan(client, tokenForRepository, validated, branch, { requireExisting: true });
    return result;
  } catch (error) {
    return {
      ok: false,
      ledger: [
        ...result.ledger,
        {
          repository: validated?.plan?.organization ?? 'fleet',
          branch,
          pull_request: null,
          url: null,
          action: 'post-admission-failed',
          error: String(error?.message ?? 'proposal branch failed final admission'),
          error_status: Number(error?.status) || null,
          rollback: `close proposal PRs from this plan and delete refs/heads/${branch} after inspection`,
        },
      ],
    };
  }
}
