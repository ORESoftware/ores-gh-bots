// Base branches live in the target repository. Forks may reuse the same
// branch name, but their heads cannot supply that target repository branch.
export function findStackedBasePullRequest(openPullRequests, repositoryFullName, baseBranch, currentNumber) {
  if (!Array.isArray(openPullRequests)) throw new TypeError('stacked dependency inventory must be an array');
  const target = String(repositoryFullName ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(target)) {
    throw new Error('stacked dependency repository must be owner/repo');
  }
  const branch = String(baseBranch ?? '').trim();
  if (!branch) return null;
  for (const pull of openPullRequests) {
    if (pull?.number === currentNumber || pull?.head?.ref !== branch) continue;
    const headRepo = String(pull?.head?.repo?.full_name ?? '').trim().toLowerCase();
    // A missing head repository is ambiguous; do not assume the branch is a fork.
    if (!headRepo) throw new Error('matching stacked branch has unknown head repository');
    if (headRepo === target) return pull;
  }
  return null;
}
