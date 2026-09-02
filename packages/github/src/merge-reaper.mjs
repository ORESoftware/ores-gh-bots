import { getPullRequest } from './pull-requests.mjs';

export async function listPullRequestReviews(client, token, owner, repo, prNumber) {
  return client.paginate(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews?per_page=100`,
    { token, map: (data) => data },
  );
}

export async function countUnresolvedReviewThreads(client, token, owner, repo, prNumber, { maxPages = 20 } = {}) {
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
      body: { query, variables: { owner, repo, number: Number(prNumber), cursor } },
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
  if (!/^[0-9a-f]{40,64}$/u.test(String(expectedHeadSha ?? ''))) {
    throw new Error('expectedHeadSha must be a 40- or 64-character lowercase hexadecimal SHA');
  }
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error(`Unsupported merge method: ${method}`);

  const current = await getPullRequest(client, token, owner, repo, prNumber);
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
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/merge`,
    { token, body },
  );
  if (response.data?.merged !== true) {
    throw new Error(`GitHub did not merge the pull request: ${response.data?.message ?? 'unknown reason'}`);
  }
  return response.data;
}
