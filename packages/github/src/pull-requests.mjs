export async function getPullRequest(client, token, owner, repo, prNumber) {
  const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`, { token });
  return response.data;
}

export async function listPullRequestFiles(client, token, owner, repo, prNumber) {
  return client.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/files?per_page=100`, {
    token,
    map: (data) => data,
  });
}

export async function listOpenPullRequests(client, token, owner, repo, perPage = 100) {
  const pulls = await client.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(perPage, 100)}`, {
    token,
    map: (data) => data,
    maxPages: Math.max(1, Math.ceil(perPage / 100)),
  });
  return pulls.slice(0, perPage);
}

export async function getCollaboratorPermission(client, token, owner, repo, username) {
  const response = await client.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`, { token });
  return response.data.permission;
}

export function permissionCanTriggerReview(permission) {
  return ['write', 'maintain', 'admin'].includes(permission);
}

export async function createPullRequestReview(client, token, owner, repo, prNumber, { body, event = 'COMMENT', commitId }) {
  const response = await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`, {
    token,
    body: { body, event, commit_id: commitId },
  });
  return response.data;
}
