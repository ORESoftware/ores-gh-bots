import { labelProvider, reviewTagProviders } from './agent-tags.mjs';
import { CHECK_NAMES, OWN_CHECK_NAMES, SUPPORTED_PULL_REQUEST_ACTIONS } from './constants.mjs';

const TRUSTED_PR_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function prJob(payload, type = 'review', reason = 'webhook') {
  const pr = payload.pull_request;
  const repository = payload.repository;
  const installationId = payload.installation?.id;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  const prNumber = pr?.number;
  const headSha = pr?.head?.sha;
  if (!installationId || !owner || !repo || !prNumber || !headSha) return null;
  return {
    type,
    installationId,
    owner,
    repo,
    prNumber,
    headSha,
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
  if (action === 'review_requested') {
    const job = prJob(payload, 'gate', 'pull_request.review_requested');
    return job ? [{ ...job, force: true }] : [];
  }
  if (action === 'labeled') {
    // agent-tag:<family> is another agent asking a family this service hosts
    // for a review. The labeler is authorized like a manual command sender.
    if (!labelProvider(payload.label?.name)) return [];
    const job = prJob(payload, 'review', 'pull_request.labeled:agent-tag');
    return job ? [{ ...job, force: true, needsAuthorization: true, sender: payload.sender?.login }] : [];
  }
  if (!SUPPORTED_PULL_REQUEST_ACTIONS.has(action)) return [];
  const job = prJob(payload, 'review', `pull_request.${action}`);
  if (!job) return [];
  const association = String(payload.pull_request?.author_association ?? '').toUpperCase();
  const trustedAuthor = TRUSTED_PR_AUTHOR_ASSOCIATIONS.has(association);
  return [{
    ...job,
    force: ['reopened', 'ready_for_review', 'edited'].includes(action),
    ...(trustedAuthor ? {} : {
      needsAuthorization: true,
      sender: payload.pull_request?.user?.login ?? payload.sender?.login ?? null,
    }),
  }];
}

function expectedOwnCheckAppId(name, expectedReviewAppIds) {
  if (!expectedReviewAppIds) return null;
  if (name === CHECK_NAMES.openai) return expectedReviewAppIds.openai ?? undefined;
  if (name === CHECK_NAMES.claude) return expectedReviewAppIds.claude ?? undefined;
  if (name === CHECK_NAMES.gate) return expectedReviewAppIds.gate ?? undefined;
  return undefined;
}

function ownCheckAppMatches(payload, name, expectedReviewAppIds) {
  if (!expectedReviewAppIds) return true;
  const expected = expectedOwnCheckAppId(name, expectedReviewAppIds);
  if (expected === undefined || expected === null || expected === '') return false;
  return String(payload.check_run?.app?.id ?? '') === String(expected);
}

function checkRunJobs(payload, action, expectedReviewAppIds = null) {
  const name = payload.check_run?.name;

  if (action === 'rerequested' && OWN_CHECK_NAMES.has(name)) {
    if (!ownCheckAppMatches(payload, name, expectedReviewAppIds)) return [];
    const type = name === CHECK_NAMES.gate ? 'gate' : 'review';
    const job = checkPullRequestJob(payload, type, `check_run.rerequested:${name}`);
    return job ? [{ ...job, force: true }] : [];
  }

  if (action === 'completed' && name && !OWN_CHECK_NAMES.has(name)) {
    const job = checkPullRequestJob(payload, 'gate', `check_run.completed:${name}`);
    return job ? [{ ...job, force: true }] : [];
  }

  if (action === 'requested_action' && OWN_CHECK_NAMES.has(name)) {
    if (!ownCheckAppMatches(payload, name, expectedReviewAppIds)) return [];
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
  const command = /^\/ores-review(?:\s|$)/i.test(body);
  const tagged = !command && reviewTagProviders(body).length > 0;
  if (!command && !tagged) return [];

  return [{
    type: command && /\bgate\b/i.test(body) ? 'gate' : 'review',
    installationId: payload.installation?.id,
    owner: payload.repository?.owner?.login,
    repo: payload.repository?.name,
    prNumber: payload.issue.number,
    headSha: null,
    reason: tagged ? 'issue_comment.agent-tag' : 'issue_comment.command',
    force: true,
    needsAuthorization: true,
    sender: payload.sender?.login,
  }];
}

function isRoutableJob(job) {
  return Boolean(job.installationId && job.owner && job.repo && job.prNumber);
}

export function routeWebhookEvent({ event, payload, expectedReviewAppIds = null }) {
  const action = payload?.action;
  const jobs = [
    ...(event === 'pull_request' ? pullRequestJobs(payload, action) : []),
    ...(event === 'check_run' ? checkRunJobs(payload, action, expectedReviewAppIds) : []),
    ...(event === 'issue_comment' ? issueCommentJobs(payload, action) : []),
  ];
  return jobs.filter(isRoutableJob);
}
