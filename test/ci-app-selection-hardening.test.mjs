import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../packages/core/src/index.mjs';
import { getCiSnapshot } from '../packages/github/src/checks.mjs';

const reviews = {
  openai: { verdict: 'approve' },
  claude: { verdict: 'approve' },
};

function check({ id, appId, status = 'completed', conclusion = 'success' }) {
  return {
    id,
    name: 'ci/verify',
    status,
    conclusion,
    app: { id: appId },
    html_url: `https://example.invalid/check/${id}`,
  };
}

test('CI snapshot retains same-name Check Runs from different Apps', async () => {
  const client = {
    async request(method, path) {
      assert.equal(method, 'GET');
      if (path.includes('/check-runs?')) {
        return { data: { check_runs: [check({ id: 10, appId: 42 }), check({ id: 20, appId: 99 })] } };
      }
      if (path.endsWith('/status')) return { data: { statuses: [] } };
      throw new Error(`unexpected path ${path}`);
    },
  };

  const snapshot = await getCiSnapshot(client, 'token', 'o', 'r', 'a'.repeat(40));
  const candidates = snapshot.filter((item) => item.context === 'ci/verify');
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => [item.id, item.appId]), [[10, 42], [20, 99]]);
});

test('a foreign newer same-name check cannot shadow the expected App', () => {
  const result = evaluateGate({
    reviews,
    requiredCiContexts: ['ci/verify'],
    requiredCiAppIds: { 'ci/verify': 42 },
    ci: [
      { id: 10, context: 'ci/verify', state: 'success', source: 'check_run', rawStatus: 'completed', rawConclusion: 'success', appId: 42 },
      { id: 20, context: 'ci/verify', state: 'failure', source: 'check_run', rawStatus: 'completed', rawConclusion: 'failure', appId: 99 },
    ],
  });

  assert.equal(result.conclusion, 'success');
  assert.match(result.ciStates[0].reason, /App-owned completed\/success/);
});

test('the newest run from the expected App wins over its older approval', () => {
  const result = evaluateGate({
    reviews,
    requiredCiContexts: ['ci/verify'],
    requiredCiAppIds: { 'ci/verify': 42 },
    ci: [
      { id: 10, context: 'ci/verify', state: 'success', source: 'check_run', rawStatus: 'completed', rawConclusion: 'success', appId: 42 },
      { id: 20, context: 'ci/verify', state: 'success', source: 'check_run', rawStatus: 'completed', rawConclusion: 'success', appId: 99 },
      { id: 30, context: 'ci/verify', state: 'failure', source: 'check_run', rawStatus: 'completed', rawConclusion: 'failure', appId: 42 },
    ],
  });

  assert.equal(result.conclusion, 'failure');
  assert.match(result.ciStates[0].reason, /not success/);
});
