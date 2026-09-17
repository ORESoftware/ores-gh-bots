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

function fakeDependencyClient({
  version = '1.2.3',
  gateStatus = 'completed',
  gateConclusion = 'success',
  gateAppId = 44,
  gateName = 'ores-review/gate',
  gateHeadSha = SHA_A,
  baseFullName = 'Other/Library',
  errorStatus = null,
  manifestText = null,
} = {}) {
  return {
    async request(method, path) {
      assert.equal(method, 'GET');
      if (errorStatus !== null) {
        const error = new Error('untrusted upstream transport detail');
        error.status = errorStatus;
        throw error;
      }
      if (path.includes('/pulls/42')) {
        return {
          data: {
            state: 'open',
            draft: false,
            merged: false,
            merged_at: null,
            head: { sha: SHA_A },
            base: { repo: { full_name: baseFullName } },
          },
        };
      }
      if (path.includes('/check-runs?')) {
        return {
          data: {
            check_runs: [{
              id: 99,
              name: gateName,
              head_sha: gateHeadSha,
              external_id: `gate:${baseFullName}#42@${SHA_A}`,
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
            content: Buffer.from(manifestText ?? `[package]\norg = "other"\nname = "library"\nversion = "${version}"\n`).toString('base64'),
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


test('normalizes persisted dependency coordinates, head SHA, and version evidence', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const result = replacePullRequestDependencies(queue, edge({
      owner: ' Org ',
      repo: ' Repo-A ',
      headSha: SHA_A.toUpperCase(),
      dependencies: [{ owner: ' Other ', repo: ' Library ', prNumber: 42, expectedVersion: 'v1.2.3' }],
    }));
    assert.equal(result.accepted[0].dependentOwner, 'org');
    assert.equal(result.accepted[0].dependentRepo, 'repo-a');
    assert.equal(result.accepted[0].dependentHeadSha, SHA_A);
    assert.equal(result.accepted[0].dependencyOwner, 'other');
    assert.equal(result.accepted[0].dependencyRepo, 'library');
    assert.equal(result.accepted[0].expectedVersion, '1.2.3');
  } finally {
    queue.close();
  }
});

test('deduplicates equivalent programmatic dependency declarations before persistence', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const result = replacePullRequestDependencies(queue, edge({
      dependencies: [
        { owner: 'Other', repo: 'Library', prNumber: 42, expectedVersion: 'v1.2.3' },
        { owner: ' other ', repo: ' library ', prNumber: 42, expectedVersion: '1.2.3' },
      ],
    }));
    assert.equal(result.accepted.length, 1);
    assert.equal(result.count, 1);
  } finally {
    queue.close();
  }
});

test('rejects conflicting programmatic dependency versions before opening a transaction', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.throws(() => replacePullRequestDependencies(queue, edge({
      dependencies: [
        { owner: 'Other', repo: 'Library', prNumber: 42, expectedVersion: '1.2.3' },
        { owner: 'Other', repo: 'Library', prNumber: 42, expectedVersion: '1.2.4' },
      ],
    })), /Conflicting version requirements/u);
  } finally {
    queue.close();
  }
});

test('orders programmatic dependency edges deterministically before cycle selection', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const result = replacePullRequestDependencies(queue, edge({
      dependencies: [
        { owner: 'zeta', repo: 'pkg', prNumber: 9, expectedVersion: null },
        { owner: 'alpha', repo: 'pkg', prNumber: 2, expectedVersion: null },
      ],
    }));
    assert.deepEqual(result.accepted.map((item) => [item.dependencyOwner, item.dependencyPrNumber]), [
      ['alpha', 2],
      ['zeta', 9],
    ]);
  } finally {
    queue.close();
  }
});

test('fails closed before network access when the trusted Gate App id is missing', async () => {
  const client = { async request() { assert.fail('network must not be touched'); } };
  const result = await evaluatePullRequestDependency({
    client,
    auth,
    gateAppId: null,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /gate App identity is not configured/u);
});

test('does not trust an exact external id attached to the wrong check head', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ gateHeadSha: SHA_B }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'pending');
  assert.match(result.reason, /gate is missing/u);
});

test('does not trust a foreign check name even when external id and App id match', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ gateName: 'build' }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'pending');
  assert.match(result.reason, /gate is missing/u);
});

test('fails closed when GitHub returns a PR from a different base repository', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ baseFullName: 'Other/Different' }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /base repository does not match/u);
});

test('repository identity comparison remains case-insensitive', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ baseFullName: 'OTHER/LIBRARY' }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'success');
});

test('sanitizes 401 dependency-read failures', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ errorStatus: 401 }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /Orchestrator App installation/u);
  assert.doesNotMatch(result.reason, /untrusted upstream/u);
});

test('classifies dependency verification rate limits without leaking transport details', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ errorStatus: 429 }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /rate-limited/u);
  assert.doesNotMatch(result.reason, /untrusted upstream/u);
});

test('classifies GitHub 5xx dependency failures as temporary upstream unavailability', async () => {
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ errorStatus: 503 }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: null },
  });
  assert.equal(result.state, 'failure');
  assert.match(result.reason, /temporarily unavailable/u);
});

test('fails closed on oversized exact-head version manifests', async () => {
  const manifestText = `[package]\nversion = "1.2.3"\n#${'x'.repeat((256 * 1024) + 1)}`;
  const result = await evaluatePullRequestDependency({
    client: fakeDependencyClient({ manifestText }),
    auth,
    gateAppId: 44,
    dependency: { owner: 'other', repo: 'library', prNumber: 42, expectedVersion: '1.2.3' },
  });
  assert.equal(result.state, 'failure');
  assert.equal(result.reason, 'upstream dependency verification failed closed');
});

test('reverse dependency propagation uses normalized persisted coordinates', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    replacePullRequestDependencies(queue, edge({
      owner: ' Org ',
      repo: ' App ',
      dependencies: [{ owner: ' Other ', repo: ' Library ', prNumber: 42, expectedVersion: null }],
    }));
    const jobs = dependentGateJobsForWebhook(queue, {
      event: 'pull_request',
      payload: {
        action: 'synchronize',
        repository: { owner: { login: 'OTHER' }, name: 'LIBRARY' },
        pull_request: { number: 42 },
      },
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].owner, 'org');
    assert.equal(jobs[0].repo, 'app');
  } finally {
    queue.close();
  }
});

test('self dependency remains ignored after persistence-boundary normalization', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const result = replacePullRequestDependencies(queue, edge({
      owner: ' Org ',
      repo: ' App ',
      dependencies: [{ owner: 'org', repo: 'app', prNumber: 1, expectedVersion: null }],
    }));
    assert.equal(result.accepted.length, 0);
    assert.equal(result.ignored.length, 1);
    assert.equal(result.ignored[0].reason, 'cycle');
  } finally {
    queue.close();
  }
});
