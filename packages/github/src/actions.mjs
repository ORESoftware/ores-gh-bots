export async function dispatchWorkflow(client, token, repository, workflowId, ref, inputs) {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error(`Invalid GHA repository: ${repository}`);
  await client.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    token,
    body: { ref, inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, String(value)])) },
  });
}
