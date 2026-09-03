import { CHECK_NAMES, OWN_CHECK_NAMES, SUPPORTED_PULL_REQUEST_ACTIONS } from './constants.mjs';

function prJob(payload, type = 'review', reason = 'webhook') {
  const pr = payload.pull_request;
  const repository = payload.repository;
  if (!pr || !repository || !payload.installation?.id) return null;
  return {
    type,
    installationId: payload.installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    prNumber: pr.number,
    headSha: pr.head.sha,
    reason,
  };
}

function checkPullRequestJob(payload, type, reason) {
  const check = payload.check_run;
  const ref = check?.pull_requests?.[0];
  if (!ref || !payload.repository || !payload.installation?.id) return null;
  return {
    type,
    installationId: payload.installation.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: ref.number,
    headSha: check.head_sha,
    reason,
  };
}

function expectedOwnAppId(policy, name) {
  const value = Number(policy?.ownAppIds?.[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isExpectedOwnCheck(payload, name, policy) {
  if (!OWN_CHECK_NAMES.has(name)) return false;
  const expected = expectedOwnAppId(policy, name);
  const actual = Number(payload.check_run?.app?.id);
  return expected !== null && Number.isSafeInteger(actual) && actual === expected;
}

function requiredCiContexts(policy) {
  return new Set((policy?.requiredCiContexts ?? []).map((value) => String(value)));
}

export function routeWebhookEvent({ event, payload, policy = {} }) {
  const jobs = [];
  const action = payload?.action;

  if (event === 'pull_request' && SUPPORTED_PULL_REQUEST_ACTIONS.has(action)) {
    const job = prJob(payload, 'review', `pull_request.${action}`);
    if (job) jobs.push({ ...job, force: ['reopened', 'ready_for_review', 'edited'].includes(action) });
  }

  if (event === 'check_run') {
    const name = payload.check_run?.name;
    const ownCheck = isExpectedOwnCheck(payload, name, policy);
    if (action === 'rerequested' && ownCheck) {
      const type = name === CHECK_NAMES.gate ? 'gate' : 'review';
      const job = checkPullRequestJob(payload, type, `check_run.rerequested:${name}`);
      if (job) jobs.push({ ...job, force: true });
    } else if (action === 'completed' && name && !OWN_CHECK_NAMES.has(name) && requiredCiContexts(policy).has(name)) {
      const job = checkPullRequestJob(payload, 'gate', `check_run.completed:${name}`);
      if (job) jobs.push({ ...job, force: true });
    } else if (action === 'requested_action' && ownCheck) {
      const identifier = payload.requested_action?.identifier;
      const validGateAction = name === CHECK_NAMES.gate && identifier === 'regate';
      const validReviewAction = name !== CHECK_NAMES.gate && identifier === 'rereview';
      if (validGateAction || validReviewAction) {
        const type = validGateAction ? 'gate' : 'review';
        const job = checkPullRequestJob(payload, type, `check_run.requested_action:${identifier}`);
        if (job) jobs.push({ ...job, force: true });
      }
    }
  }

  if (event === 'issue_comment' && action === 'created' && payload.issue?.pull_request) {
    const body = String(payload.comment?.body ?? '').trim();
    if (/^\/ores-review(?:\s|$)/i.test(body)) {
      jobs.push({
        type: /\bgate\b/i.test(body) ? 'gate' : 'review',
        installationId: payload.installation?.id,
        owner: payload.repository?.owner?.login,
        repo: payload.repository?.name,
        prNumber: payload.issue.number,
        headSha: null,
        reason: 'issue_comment.command',
        force: true,
        needsAuthorization: true,
        sender: payload.sender?.login,
      });
    }
  }

  return jobs.filter((job) => job.installationId && job.owner && job.repo && job.prNumber);
}
