import { CHECK_NAMES } from '../../core/src/constants.mjs';

export const RULESET_NAME = 'ORES dual-AI pull-request gate';

export function buildRulesetPayload({
  enforcement = 'evaluate',
  branchMode = 'all',
  protectedBranchPatterns = ['refs/heads/main', 'refs/heads/master', 'refs/heads/dev', 'refs/heads/release/**'],
  appIds = {},
  rulesetName = RULESET_NAME,
}) {
  if (!['disabled', 'evaluate', 'active'].includes(enforcement)) throw new Error(`Invalid enforcement: ${enforcement}`);
  if (!['all', 'protected'].includes(branchMode)) throw new Error(`Invalid branch mode: ${branchMode}`);
  const include = branchMode === 'all' ? ['refs/heads/**'] : protectedBranchPatterns;
  const required = [
    [CHECK_NAMES.openai, appIds.openai],
    [CHECK_NAMES.claude, appIds.claude],
    [CHECK_NAMES.gate, appIds.gate],
  ].map(([context, integrationId]) => ({
    context,
    ...(integrationId ? { integration_id: Number(integrationId) } : {}),
  }));

  return {
    name: rulesetName,
    target: 'branch',
    enforcement,
    bypass_actors: [],
    conditions: { ref_name: { include, exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: true,
          required_status_checks: required,
          strict_required_status_checks_policy: true,
        },
      },
      { type: 'deletion' },
      { type: 'non_fast_forward' },
    ],
  };
}

export async function listRepositoryRulesets(client, token, owner, repo) {
  const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets?includes_parents=false&per_page=100`, { token });
  return response.data;
}

export async function upsertRepositoryRuleset(client, token, owner, repo, payload, { dryRun = false } = {}) {
  const existing = (await listRepositoryRulesets(client, token, owner, repo)).find((ruleset) => ruleset.name === payload.name);
  if (dryRun) return { action: existing ? 'update' : 'create', existing, payload };
  if (existing) {
    const response = await client.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets/${existing.id}`, {
      token,
      body: payload,
    });
    return { action: 'updated', ruleset: response.data };
  }
  const response = await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rulesets`, {
    token,
    body: payload,
  });
  return { action: 'created', ruleset: response.data };
}
