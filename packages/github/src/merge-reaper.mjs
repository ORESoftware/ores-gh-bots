import { getPullRequest } from './pull-requests.mjs';

const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/u;

function coordinates(owner, repo, prNumber) {
  const safeOwner = String(owner ?? '').trim();
  const safeRepo = String(repo ?? '').trim();
  const number = Number(prNumber);
  if (!REPOSITORY_PART.test(safeOwner) || safeOwner === '.' || safeOwner === '..') {
    throw new Error('repository owner is invalid');
  }
  if (!REPOSITORY_PART.test(safeRepo) || safeRepo === '.' || safeRepo === '..') {
    throw new Error('repository name is invalid');
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new Error('pull request number is invalid');
  }
  return { owner: safeOwner, repo: safeRepo, prNumber: number };
}

export async function listMergeReaperPullRequestReviews(client, token, owner, repo, prNumber) {
  const target = coordinates(owner, repo, prNumber);
  return client.paginate(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.prNumber}/reviews?per_page=100`,
    { token, maxPages: 10, map: (data) => (Array.isArray(data) ? data : []) },
  );
}

export async function countUnresolvedReviewThreads(client, token, owner, repo, prNumber, { maxPages = 20 } = {}) {
  const target = coordinates(owner, repo, prNumber);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('maxPages must be an integer between 1 and 100');
  }
  const query = `query PullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  let cursor = null;
  let unresolved = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.request('POST', '/graphql', {
      token,
      body: { query, variables: { owner: target.owner, repo: target.repo, number: target.prNumber, cursor } },
    });
    if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
      throw new Error(`GitHub review-thread query failed: ${response.data.errors[0]?.message ?? 'unknown error'}`);
    }
    const threads = response.data?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error('GitHub review-thread query did not return a pull request');
    unresolved += (threads.nodes ?? []).filter((thread) => thread?.isResolved !== true).length;
    if (!threads.pageInfo?.hasNextPage) return unresolved;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) throw new Error('GitHub review-thread pagination did not return an end cursor');
  }
  throw new Error(`GitHub review-thread query exceeded ${maxPages} pages`);
}

export async function mergePullRequestExact(client, token, owner, repo, prNumber, {
  expectedHeadSha,
  method = 'squash',
  commitTitle,
  commitMessage,
} = {}) {
  const target = coordinates(owner, repo, prNumber);
  if (!/^[0-9a-f]{40,64}$/u.test(String(expectedHeadSha ?? ''))) {
    throw new Error('expectedHeadSha must be a 40- or 64-character lowercase hexadecimal SHA');
  }
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error(`Unsupported merge method: ${method}`);

  const current = await getPullRequest(client, token, target.owner, target.repo, target.prNumber);
  if (current.state !== 'open') throw new Error('Pull request is no longer open');
  if (current.draft) throw new Error('Pull request became a draft');
  if (current.head?.sha !== expectedHeadSha) throw new Error('Pull request head changed before merge');
  if (current.mergeable !== true || current.mergeable_state !== 'clean') {
    throw new Error(`Pull request is not cleanly mergeable (${current.mergeable_state ?? 'unknown'})`);
  }

  const body = {
    sha: expectedHeadSha,
    merge_method: method,
  };
  if (commitTitle) body.commit_title = String(commitTitle).slice(0, 256);
  if (commitMessage) body.commit_message = String(commitMessage).slice(0, 65_535);
  const response = await client.request(
    'PUT',
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.prNumber}/merge`,
    { token, body },
  );
  if (response.data?.merged !== true) {
    throw new Error(`GitHub did not merge the pull request: ${response.data?.message ?? 'unknown reason'}`);
  }
  return response.data;
}
