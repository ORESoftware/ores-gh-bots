import test from 'node:test';
import assert from 'node:assert/strict';
import { getCiSnapshot } from '../packages/github/src/checks.mjs';

function clientWithSnapshot({
  checkRuns = [],
  totalCount = checkRuns.length,
  statuses = [],
  omitTotal = false,
  omitChecks = false,
  omitStatuses = false,
} = {}) {
  const requests = [];
  return {
    requests,
    async request(method, path) {
      requests.push({ method, path });
      if (path.includes('/check-runs?')) {
        const data = {};
        if (!omitChecks) data.check_runs = checkRuns;
        if (!omitTotal) data.total_count = totalCount;
        return { data };
      }
      if (path.includes('/status?')) {
        return { data: omitStatuses ? {} : { statuses } };
      }
      throw new Error('unexpected GitHub API route');
    },
  };
}

test('CI snapshot accepts complete, bounded checks and preserves failed checks', async () => {
  const c = clientWithSnapshot({
    checkRuns: [{
      id: 4,
      name: 'native-test',
      status: 'completed',
      conclusion: 'failure',
      app: { id: 15368 },
      html_url: 'https://example.invalid/check',
    }],
    statuses: [{ id: 3, context: 'legacy-ci', state: 'success' }],
  });
  const checks = await getCiSnapshot(c, 'test-token', 'owner', 'repo', 'a'.repeat(40));
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((check) => [check.context, check.state]), [
    ['native-test', 'failure'],
    ['legacy-ci', 'success'],
  ]);
  assert.equal(c.requests.every((request) => request.method === 'GET'), true);
  assert.ok(c.requests.some((request) => request.path.endsWith('/status?per_page=100')));
});

test('CI snapshot rejects truncated check-run pages and ambiguous boundary sizes', async () => {
  const one = { id: 1, name: 'compile', status: 'completed', conclusion: 'success', app: { id: 1 } };
  for (const options of [
    { checkRuns: [one], totalCount: 101 },
    { checkRuns: [one], totalCount: 0 },
    { checkRuns: Array.from({ length: 100 }, (_, i) => ({ ...one, id: i + 1, name: `check-${i}` })) },
    { checkRuns: [one], omitTotal: true },
    { checkRuns: [one], omitChecks: true },
  ]) {
    const c = clientWithSnapshot(options);
    await assert.rejects(
      getCiSnapshot(c, 't', 'o', 'r', 'a'.repeat(40)),
      /CI check-run snapshot incomplete/u,
    );
  }
});

test('CI snapshot rejects missing or full commit-status pages rather than hiding failed contexts', async () => {
  const statuses = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    context: `commit-status-${i}`,
    state: i === 99 ? 'failure' : 'success',
  }));
  for (const c of [
    clientWithSnapshot({ statuses }),
    clientWithSnapshot({ omitStatuses: true }),
  ]) {
    await assert.rejects(
      getCiSnapshot(c, 't', 'o', 'r', 'b'.repeat(40)),
      /CI commit-status snapshot incomplete/u,
    );
  }
});
