import { CHECK_NAMES, OWN_CHECK_NAMES } from '../../core/src/constants.mjs';
import { isSafeRepositoryPath } from '../../core/src/review-schema.mjs';

function annotationLevel(severity) {
  if (['critical', 'high'].includes(severity)) return 'failure';
  if (['medium', 'low'].includes(severity)) return 'warning';
  return 'notice';
}

function errorStatus(error) {
  return Number(error?.status ?? error?.response?.status ?? 0);
}

export function checkExternalId(role, owner, repo, prNumber, headSha) {
  if (!['openai', 'claude', 'gate'].includes(role)) throw new Error(`Invalid check role: ${role}`);
  return `${role}:${owner}/${repo}#${prNumber}@${headSha}`;
}

export function reviewAnnotations(review) {
  return review.findings
    .filter((finding) => finding.path
      && isSafeRepositoryPath(finding.path)
      && Number.isInteger(finding.line)
      && finding.line > 0
      && finding.line <= 2_147_483_647)
    .slice(0, 50)
    .map((finding) => ({
      path: finding.path,
      start_line: finding.line,
      end_line: finding.line,
      annotation_level: annotationLevel(finding.severity),
      title: finding.title.slice(0, 255),
      message: finding.body.slice(0, 65_000),
      raw_details: finding.suggestion ? `Suggested direction:\n${finding.suggestion}`.slice(0, 65_000) : undefined,
    }));
}

export async function createCheckRun(client, token, owner, repo, input) {
  const response = await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`, {
    token,
    body: input,
  });
  return response.data;
}

export async function updateCheckRun(client, token, owner, repo, checkRunId, input) {
  const response = await client.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`, {
    token,
    body: input,
  });
  return response.data;
}

export async function findLatestCheckRun(
  client,
  token,
  owner,
  repo,
  headSha,
  name,
  { externalId = null, appId = null } = {},
) {
  const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`, { token });
  return (response.data.check_runs ?? [])
    .filter((check) => externalId === null || check.external_id === externalId)
    .filter((check) => appId === null || Number(check.app?.id) === Number(appId))
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

export async function ensureInProgressCheck({
  client,
  token,
  owner,
  repo,
  headSha,
  name,
  detailsUrl,
  externalId,
  summary,
  expectedAppId = null,
}) {
  const existing = await findLatestCheckRun(client, token, owner, repo, headSha, name, {
    externalId,
    appId: expectedAppId,
  });
  const payload = {
    name,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    details_url: detailsUrl || undefined,
    external_id: externalId,
    output: {
      title: name,
      summary: summary.slice(0, 65_535),
    },
  };
  if (existing && existing.status !== 'completed') {
    const { head_sha: _headSha, ...updatePayload } = payload;
    try {
      return await updateCheckRun(client, token, owner, repo, existing.id, updatePayload);
    } catch (error) {
      if (![403, 404, 422].includes(errorStatus(error))) throw error;
      // A stale or foreign check can never block creation of a run owned by the
      // configured reviewer App. Other errors remain fail closed.
    }
  }
  return createCheckRun(client, token, owner, repo, payload);
}

export async function completeReviewCheck({ client, token, owner, repo, checkRunId, name, review, detailsUrl }) {
  const conclusion = review.verdict === 'approve' ? 'success' : 'failure';
  const findings = review.findings.map((item) => `- **${item.severity}** ${item.path ? `\`${item.path}${item.line ? `:${item.line}` : ''}\`` : ''} ${item.title}: ${item.body}`);
  const text = [
    `Verdict: **${review.verdict}**`,
    `Risk: **${review.risk}** · Confidence: **${Math.round(review.confidence * 100)}%**`,
    '',
    review.summary,
    findings.length ? `\n## Findings\n${findings.join('\n')}` : '\nNo findings were reported.',
    review.tests.length ? `\n## Suggested validation\n${review.tests.map((item) => `- ${item}`).join('\n')}` : '',
  ].join('\n').slice(0, 65_535);

  const annotations = reviewAnnotations(review);
  const payload = {
    name,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    details_url: detailsUrl || undefined,
    output: {
      title: `${name}: ${review.verdict}`.slice(0, 255),
      summary: review.summary.slice(0, 65_535),
      text,
      annotations,
    },
    actions: [{
      label: 'Re-review',
      description: 'Run both ORES AI reviewers again for this SHA.',
      identifier: 'rereview',
    }],
  };

  try {
    return await updateCheckRun(client, token, owner, repo, checkRunId, payload);
  } catch (error) {
    if (errorStatus(error) !== 422 || annotations.length === 0) throw error;
    const withoutAnnotations = structuredClone(payload);
    delete withoutAnnotations.output.annotations;
    return updateCheckRun(client, token, owner, repo, checkRunId, withoutAnnotations);
  }
}

export async function completeFailedCheck({ client, token, owner, repo, checkRunId, name, summary, detailsUrl }) {
  return updateCheckRun(client, token, owner, repo, checkRunId, {
    name,
    status: 'completed',
    conclusion: 'failure',
    completed_at: new Date().toISOString(),
    details_url: detailsUrl || undefined,
    output: { title: `${name}: failed`, summary: summary.slice(0, 65_535) },
    actions: [{ label: 'Re-review', description: 'Retry the ORES review.', identifier: 'rereview' }],
  });
}

export async function completeGateCheck({ client, token, owner, repo, checkRunId, gate, detailsUrl }) {
  const providerLines = gate.providerStates.map((item) => `- ${item.provider}: **${item.state}** — ${item.reason}`);
  const ciLines = gate.ciStates.map((item) => `- ${item.context}: **${item.state}** — ${item.reason}`);
  const summary = [
    '## Provider reviews',
    ...providerLines,
    ciLines.length ? '\n## Required CI' : '',
    ...ciLines,
  ].filter(Boolean).join('\n');

  const payload = {
    name: CHECK_NAMES.gate,
    status: gate.status,
    details_url: detailsUrl || undefined,
    output: {
      title: gate.status === 'completed' ? `ORES review gate: ${gate.conclusion}` : 'ORES review gate: waiting',
      summary: summary.slice(0, 65_535),
    },
  };
  if (gate.status === 'completed') {
    payload.conclusion = gate.conclusion;
    payload.completed_at = new Date().toISOString();
    payload.actions = [{ label: 'Re-evaluate', description: 'Re-evaluate provider and CI results.', identifier: 'regate' }];
  }
  return updateCheckRun(client, token, owner, repo, checkRunId, payload);
}

function normalizeCheckState(check) {
  if (check.status !== 'completed') return check.status;
  return check.conclusion === 'success' ? 'success' : (check.conclusion ?? 'failure');
}

export async function getCiSnapshot(client, token, owner, repo, headSha) {
  const checksResponse = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${headSha}/check-runs?filter=latest&per_page=100`, { token });
  const statusesResponse = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${headSha}/status`, { token });
  const latest = new Map();
  for (const check of checksResponse.data.check_runs ?? []) {
    if (OWN_CHECK_NAMES.has(check.name)) continue;
    const current = latest.get(check.name);
    if (!current || check.id > current.id) latest.set(check.name, {
      id: check.id,
      context: check.name,
      state: normalizeCheckState(check),
      appId: check.app?.id ?? null,
      url: check.html_url,
    });
  }
  for (const status of statusesResponse.data.statuses ?? []) {
    if (OWN_CHECK_NAMES.has(status.context)) continue;
    if (!latest.has(status.context)) latest.set(status.context, {
      id: status.id,
      context: status.context,
      state: status.state,
      appId: null,
      url: status.target_url,
    });
  }
  return [...latest.values()];
}
