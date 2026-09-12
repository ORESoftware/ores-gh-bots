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
  const check = payload.check_run ?? payload.check_suite;
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

function pullRequestJobs(payload, action) {
  if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(action)) return [];
  const job = prJob(payload, 'review', `pull_request.${action}`);
  return job
    ? [{ ...job, force: ['reopened', 'ready_for_review', 'edited'].includes(action) }]
    : [];
}

function checkRunJobs(payload, action) {
  const name = payload.check_run?.name;

  if (action === 'rerequested' && OWN_CHECK_NAMES.has(name)) {
    const type = name === CHECK_NAMES.gate ? 'gate' : 'review';
    const job = checkPullRequestJob(payload, type, `check_run.rerequested:${name}`);
    return job ? [{ ...job, force: true }] : [];
  }

  if (action === 'completed' && name && !OWN_CHECK_NAMES.has(name)) {
    const job = checkPullRequestJob(payload, 'gate', `check_run.completed:${name}`);
    return job ? [{ ...job, force: true }] : [];
  }

  if (action === 'requested_action' && OWN_CHECK_NAMES.has(name)) {
    const identifier = payload.requested_action?.identifier;
    const type = name === CHECK_NAMES.gate || identifier === 'regate' ? 'gate' : 'review';
    const job = checkPullRequestJob(payload, type, `check_run.requested_action:${identifier ?? 'unknown'}`);
    return job ? [{ ...job, force: true }] : [];
  }

  return [];
}

function issueCommentJobs(payload, action) {
  if (action !== 'created' || !payload.issue?.pull_request) return [];
  const body = String(payload.comment?.body ?? '').trim();
  if (!/^\/ores-review(?:\s|$)/i.test(body)) return [];

  return [{
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
  }];
}

function isRoutableJob(job) {
  return Boolean(job.installationId && job.owner && job.repo && job.prNumber);
}

export function routeWebhookEvent({ event, payload }) {
  const action = payload?.action;

  // Construct each result set independently and combine new arrays instead of
  // mutating a shared accumulator. Webhook routing is control-plane code, not a
  // measured allocation hot path, so referentially transparent construction is
  // preferred over push-based state mutation here.
  const jobs = [
    ...(event === 'pull_request' ? pullRequestJobs(payload, action) : []),
    ...(event === 'check_run' ? checkRunJobs(payload, action) : []),
    ...(event === 'issue_comment' ? issueCommentJobs(payload, action) : []),
  ];

  // `check_run.completed` is the canonical CI re-evaluation trigger. GitHub also
  // emits `check_suite.completed` for the same activity, but a suite does not
  // identify individual check names and can be emitted for ORES-owned checks.
  // Routing both events therefore creates duplicate work and can recursively
  // re-enqueue the aggregate gate when the gate itself completes.

  return jobs.filter(isRoutableJob);
}
