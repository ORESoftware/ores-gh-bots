import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGate,
  parsePullRequestDependencies,
} from '../packages/core/src/index.mjs';
import { evaluatePullRequestDependency } from '../packages/github/src/index.mjs';
import {
  dependentGateJobsForWebhook,
  replacePullRequestDependencies,
  SqliteQueue,
} from '../packages/queue/src/index.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function edge({ owner = 'Org', repo = 'repo-a', prNumber = 1, headSha = SHA_A, installationId = 10, dependencies = [] } = {}) {
  return {
    dependentOwner: owner,
    dependentRepo: repo,
    dependentPrNumber: prNumber,
    dependentHeadSha: headSha,
    dependentInstallationId: installationId,
    declarations: dependencies,
  };
}

test('parses exact-version cross-repo and local PR dependency declarations', () => {
  const parsed = parsePullRequestDependencies([
    'Depends on: Other/Library#42 @ v1.2.3',
    'Depends on #7',
    'unrelated prose',
  ].join('\n'), { owner: 'Org', repo: 'App' });

  assert.deepEqual(parsed, [
    {
      owner: 'org',
      repo: 'app',
      prNumber: 7,
      expectedVersion: null,
      key: 'org/app#7',
    },
    {
      owner: 'other',
      repo: 'library',
      prNumber: 42,
      expectedVersion: '1.2.3',
      key: 'other/library#42',
    },
  ]);
});

test('rejects conflicting version declarations for the same dependency', () => {
  assert.throws(() => parsePullRequestDependencies([
    'Depends on: Org/Lib#9 @ v1.2.3',
    'Depends on: Org/Lib#9 @ v1.2.4',
  ].join('\n'), { owner: 'Org', repo: 'App' }), /Conflicting version requirements/u);
});

test('breaks dependency cycles by ignoring the edge that closes the cycle', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const first = replacePullRequestDependencies(queue, edge({
      owner: 'Org',
      repo: 'a',
      prNumber: 1,
      dependencies: [{ owner: 'org', repo: 'b', prNumber: 2, expectedVersion: null }],
    }));
    assert.equal(first.accepted.length, 1);
    assert.equal(first.ignored.length, 0);

    const closing = replacePullRequestDependencies(queue, edge({
      owner: 'Org',
      repo: 'b',
      prNumber: 2,
      headSha: SHA_B,
      installationId: 11,
      dependencies: [{ owner: 'org', repo: 'a', prNumber: 1, expectedVersion: null }],
    }));
    assert.equal(closing.accepted.length, 0);
    assert.equal(closing.ignored.length, 1);
    assert.equal(closing.ignored[0].reason, 'cycle');

    const downstream = dependentGateJobsForWebhook(queue, {
      event: 'pull_request',
      payload: {
        action: 'synchronize',
        repository: { owner: { login: 'Org' }, name: 'b' },
        pull_request: { number: 2 },
      },
    });
    assert.equal(downstream.length, 1);
    assert.equal(downstream[0].owner, 'org');
    assert.equal(downstream[0].repo, 'a');
    assert.equal(downstream[0].prNumber, 1);

    const reverse = dependentGateJobsForWebhook(queue, {
      event: 'pull_request',
      payload: {
        action: 'synchronize',
        repository: { owner: { login: 'Org' }, name: 'a' },
        pull_request: { number: 1 },
      },
    });
    assert.deepEqual(reverse, []);
  } finally {
    queue.close();
  }
});

test('self dependency is ignored instead of blocking the gate', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const selected = replacePullRequestDependencies(queue, edge({
      owner: 'Org',
      repo: 'a',
      prNumber: 1,
      dependencies: [{ owner: 'org', repo: 'a', prNumber: 1, expectedVersion: '1.0.0' }],
    }));
    assert.equal(selected.accepted.length, 0);
    assert.equal(selected.ignored.length, 1);
  } finally {
    queue.close();
  }
});

function fakeDependencyClient({ version = '1.2.3', gateStatus = 'completed', gateConclusion = 'success', gateAppId = 44 } = {}) {
  return {
    async request(method, path) {
      assert.equal(method, 'GET');
      if (path.includes('/pulls/42')) {
        return {
          data: {
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            head: { sha: SHA_A },
            base: { repo: { full_name: 'Other/Library' } },
          },
        };
      }
      if (path.includes('/check-runs?')) {
        return {
          data: {
            check_runs: [{
              id: 99,
              name: 'ores-review/gate',
              external_id: `gate:Other/Library#42@${SHA_A}`,
              status: gateStatus,
              conclusion: gateConclusion,
              app: { id: gateAppId },
            }],
          },
        };
      }
      if (path.includes('/contents/.zpkg.toml?')) {
        return {
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(`[package]\norg = "other"\nname = "library"\nversion = "${version}"\n`).toString('base64'),
          },
        };
      }
      const error = new Error(`unexpected request: ${path}`);
      error.status = 404;
      throw error;
    },
  };
}

const auth = {
  async repoToken(role, owner, repo) {
    assert.equal(role, 'orchestrator');
    assert.equal(owner, 'other');
    assert.equal(repo, 'library');
    return { token: 'test-token', installationId: 8 };
  },
};

test('requires trusted exact-head upstream gate and exact zpkg package version', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient(),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: '1.2.3' },
  });
  assert.equal(result.state, 'success');
  assert.equal(result.actualVersion, '1.2.3');
  assert.equal(result.versionSource, '.zpkg.toml');
});

test('version mismatch fails the dependency state', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ version: '1.2.4' }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: '1.2.3' },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /required version 1\.2\.3/u);
});

test('upstream in-progress gate keeps downstream gate pending', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ gateStatus: 'in_progress', gateConclusion: null }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'pending');
});

test('aggregate gate includes dependency state and lets ignored cycles pass', () => {
  const base = {
    reviews: {
      openai: { verdict: 'approve' },
      claude: { verdict: 'approve' },
    },
    ci: [],
    requiredCiContexts: [],
    projectionAdmissions: [],
    requiredProjectionKinds: [],
  };

  const pass = evaluateGate({
    ...base,
    dependencyStates: [{
      dependency: 'org/a#1',
      state: 'success',
      reason: 'dependency cycle detected; edge ignored by policy',
      ignored: true,
    }],
  });
  assert.equal(pass.conclusion, 'success');

  const fail = evaluateGate({
    ...base,
    dependencyStates: [{ dependency: 'org/b#2', state: 'failure', reason: 'version mismatch' }],
  });
  assert.equal(fail.conclusion, 'failure');
});

function gateWebhook({ appId = 44, externalId = `gate:Org/b#2@${SHA_B}`, headSha = SHA_B } = {}) {
  return {
    action: 'completed',
    repository: { owner: { login: 'Org' }, name: 'b' },
    check_run: {
      name: 'ores-review/gate',
      external_id: externalId,
      head_sha: headSha,
      app: { id: appId },
      pull_requests: [],
    },
  };
}

test('only trusted exact ORES gate check events trigger reverse dependency re-gating', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    replacePullRequestDependencies(queue, edge({
      owner: 'Org',
      repo: 'a',
      prNumber: 1,
      dependencies: [{ owner: 'org', repo: 'b', prNumber: 2, expectedVersion: null }],
    }));

    const ordinaryCi = dependentGateJobsForWebhook(queue, {
      event: 'check_run',
      expectedGateAppId: 44,
      payload: { ...gateWebhook(), check_run: { ...gateWebhook().check_run, name: 'build' } },
    });
    assert.deepEqual(ordinaryCi, []);

    const foreignGate = dependentGateJobsForWebhook(queue, {
      event: 'check_run',
      expectedGateAppId: 44,
      payload: gateWebhook({ appId: 999 }),
    });
    assert.deepEqual(foreignGate, []);

    const malformedGate = dependentGateJobsForWebhook(queue, {
      event: 'check_run',
      expectedGateAppId: 44,
      payload: gateWebhook({ externalId: `gate:Other/b#2@${SHA_B}` }),
    });
    assert.deepEqual(malformedGate, []);

    const wrongHeadGate = dependentGateJobsForWebhook(queue, {
      event: 'check_run',
      expectedGateAppId: 44,
      payload: gateWebhook({ headSha: SHA_A }),
    });
    assert.deepEqual(wrongHeadGate, []);

    const gate = dependentGateJobsForWebhook(queue, {
      event: 'check_run',
      expectedGateAppId: 44,
      payload: gateWebhook(),
    });
    assert.equal(gate.length, 1);
    assert.equal(gate[0].type, 'gate');
    assert.equal(gate[0].prNumber, 1);
  } finally {
    queue.close();
  }
});
