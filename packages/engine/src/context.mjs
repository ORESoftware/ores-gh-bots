import { collectPullRequestFiles, redactText } from '../../core/src/index.mjs';

export function buildReviewContext({ pullRequest, files, reviewConfig }) {
  const collected = collectPullRequestFiles(files, reviewConfig);
  if (!collected.collection.complete) {
    const { omitted_files, truncated_files, binary_or_unavailable_files } = collected.collection;
    throw new Error(
      `pull-request diff coverage is incomplete (omitted=${omitted_files}, truncated=${truncated_files}, binary_or_unavailable=${binary_or_unavailable_files})`,
    );
  }
  return {
    repository: pullRequest.base.repo.full_name,
    number: pullRequest.number,
    title: redactText(pullRequest.title ?? ''),
    body: redactText(pullRequest.body ?? ''),
    author: pullRequest.user?.login ?? 'unknown',
    baseRef: pullRequest.base.ref,
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    draft: Boolean(pullRequest.draft),
    additions: pullRequest.additions ?? 0,
    deletions: pullRequest.deletions ?? 0,
    changedFiles: pullRequest.changed_files ?? files.length,
    files: collected.files,
    collection: collected.collection,
    timeoutMs: reviewConfig.timeoutMs,
    maxFindings: reviewConfig.maxFindings,
  };
}
