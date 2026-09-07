import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  Metrics,
  validateContractAdmissionPolicy,
} from '../packages/core/src/index.mjs';
import { ReviewEngine } from '../packages/engine/src/index.mjs';
import { SqliteQueue } from '../packages/queue/src/index.mjs';
import { makeContractAdmissionFixture } from './helpers/contract-admission-fixture.mjs';

const approved = {
  verdict: 'approve',
  summary: 'Looks correct.',
  confidence: 0.99,
  risk: 'low',
  findings: [],
  tests: [],
  blocking_reasons: [],
};

function pullRequest(headSha, { headRepository = 'O/R' } = {}) {
  return {
    number: 1,
    state: 'open',
    draft: false,
    title: 'Contract projection update',
    body: 'Body',
    additions: 3,
    deletions: 0,
    changed_files: 3,
    user: { login: 'alex' },
    base: { ref: 'main', repo: { full_name: 'O/R' } },
    head: { ref: 'feature', sha: headSha, repo: { full_name: headRepository } },
  };
}

function contentResponse(path, text, index) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    type: 'file',
    path,
    sha: String(index).repeat(40),
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  };
}

function fakeClient(fixture, {
  pullHeads = [fixture.headSha, fixture.headSha],
  headRepository = 'O/R',
  producerChecks = null,
  artifactTexts = {},
  missingPaths = [],
  transientPath = null,
} = {}) {
  const calls = [];
  let checkId = 100;
  let pullRead = 0;
  let transientThrown = false;
  const defaultCheck = {
    id: 42,
    name: fixture.producerCheckName,
    head_sha: fixture.headSha,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-09-07T04:30:00.000Z',
    app: { id: fixture.producerCheckAppId },
  };
  const texts = {
    [fixture.paths.report]: fixture.reportText,
    [fixture.paths.contractIr]: fixture.contractIrText,
    [fixture.paths.manifest]: fixture.manifestText,
    ...artifactTexts,
  };
  const encodedPaths = new Map(
    Object.keys(texts).map((path) => [
      path.split('/').map((segment) => encodeURIComponent(segment)).join('/'),
      path,
    ]),
  );

  return {
    calls,
    async request(method, path, options = {}) {
      calls.push({ method, path, options });
      if (method === 'GET' && /\/pulls\/1$/u.test(path)) {
        const sha = pullHeads[Math.min(pullRead, pullHeads.length - 1)];
        pullRead += 1;
        return { data: pullRequest(sha, { headRepository }) };
      }
      if (method === 'GET' && path.includes('check_name=ores-review%2Fgate')) {
        return { data: { check_runs: [] } };
      }
      if (method === 'GET' && path.includes(`check_name=${encodeURIComponent(fixture.producerCheckName)}`)) {
        return { data: { check_runs: producerChecks ?? [defaultCheck] } };
      }
      if (method === 'GET' && path.includes('/contents/')) {
        const encoded = path.slice(path.indexOf('/contents/') + '/contents/'.length).split('?', 1)[0];
        const repositoryPath = encodedPaths.get(encoded) ?? decodeURIComponent(encoded);
        if (repositoryPath === transientPath && !transientThrown) {
          transientThrown = true;
          throw Object.assign(new Error('temporary GitHub service failure'), { status: 503 });
        }
        if (missingPaths.includes(repositoryPath) || !Object.hasOwn(texts, repositoryPath)) {
          throw Object.assign(new Error(`missing ${repositoryPath}`), { status: 404 });
        }
        const index = [...Object.keys(texts)].indexOf(repositoryPath) + 1;
        return { data: contentResponse(repositoryPath, texts[repositoryPath], index) };
      }
      if (method === 'GET' && path.includes('/check-runs?filter=latest')) {
        return { data: { check_runs: [] } };
      }
      if (method === 'GET' && path.endsWith('/status')) {
        return { data: { statuses: [] } };
      }
      if (method === 'POST' && path.endsWith('/check-runs')) {
        return { data: { id: ++checkId, ...options.body } };
      }
      if (method === 'PATCH' && path.includes('/check-runs/')) {
        return { data: { id: Number(path.split('/').at(-1)), ...options.body } };
      }
      if (method === 'POST' && path.endsWith('/reviews')) {
        return { data: { id: 1 } };
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function activeConfig(fixture) {
  const config = loadConfig({
    OWNER_ALLOWLIST: 'O',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    GHA_MODE: 'disabled',
    POST_PULL_REQUEST_REVIEW: 'false',
  });
  config.contractAdmission.policy = validateContractAdmissionPolicy(fixture.policy);
  return config;
}

const auth = {
  async repoToken(role) {
    return { installationId: 1, token: `token-${role}` };
  },
};

function captureLogger() {
  const events = [];
  return {
    events,
    child() { return this; },
    info(message, fields) { events.push({ level: 'info', message, fields }); },
    warn(message, fields) { events.push({ level: 'warn', message, fields }); },
    error(message, fields) { events.push({ level: 'error', message, fields }); },
    debug(message, fields) { events.push({ level: 'debug', message, fields }); },
  };
}

function seedApprovals(queue, headSha) {
  for (const provider of ['openai', 'claude']) {
    queue.recordReview({
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      headSha,
      provider,
      result: approved,
      checkRunId: provider === 'openai' ? 11 : 12,
    });
  }
}

function gateJob(headSha) {
  return {
    id: 1,
    type: 'gate',
    installationId: 1,
    owner: 'O',
    repo: 'R',
    prNumber: 1,
    headSha,
    reason: 'contract-test',
    attempts: 1,
    maxAttempts: 3,
  };
}

function createEngine(fixture, client, queue, logger = captureLogger()) {
  return {
    logger,
    engine: new ReviewEngine({
      config: activeConfig(fixture),
      client,
      auth,
      queue,
      logger,
      metrics: new Metrics(),
      now: () => Date.parse('2026-09-07T05:00:00.000Z'),
    }),
  };
}

test('engine admits exact App-owned Contract IR evidence and persists its receipt', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture);
  const { engine, logger } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.status, 'completed');
    assert.equal(gate.conclusion, 'success');
    assert.deepEqual(gate.projectionStates, [{
      projectionKind: 'protobuf',
      state: 'success',
      reason: 'exact Contract IR evidence admitted',
    }]);

    const contentCalls = client.calls.filter((call) => call.method === 'GET' && call.path.includes('/contents/'));
    assert.equal(contentCalls.length, 3);
    assert.ok(contentCalls.every((call) => call.path.endsWith(`?ref=${fixture.headSha}`)));

    const receipt = queue.getContractAdmission({
      owner: 'O',
      repo: 'R',
      prNumber: 1,
      headSha: fixture.headSha,
      projectionKind: 'protobuf',
    });
    assert.equal(receipt?.result.admissible, true);
    assert.equal(receipt?.producerCheckRunId, 42);
    assert.equal(receipt?.producerAppId, fixture.producerCheckAppId);

    const gateUpdate = client.calls.find(
      (call) => call.method === 'PATCH' && call.options.body?.name === 'ores-review/gate',
    );
    assert.match(gateUpdate.options.body.output.summary, /## Contract projections/u);
    assert.match(gateUpdate.options.body.output.summary, /protobuf: \*\*success\*\*/u);

    const renderedLogs = JSON.stringify(logger.events);
    assert.doesNotMatch(renderedLogs, /Example\.User/u);
    assert.doesNotMatch(renderedLogs, /authored\.schema\.json/u);
  } finally {
    queue.close();
  }
});

test('engine keeps required projection evidence pending while the producer check runs', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, {
    producerChecks: [{
      id: 42,
      name: fixture.producerCheckName,
      head_sha: fixture.headSha,
      status: 'in_progress',
      conclusion: null,
      completed_at: null,
      app: { id: fixture.producerCheckAppId },
    }],
  });
  const { engine } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.status, 'in_progress');
    assert.equal(gate.conclusion, null);
    assert.equal(gate.projectionStates[0].state, 'pending');
    assert.equal(gate.projectionStates[0].reason, 'admission evidence missing');
    assert.equal(client.calls.some((call) => call.path.includes('/contents/')), false);
    assert.equal(queue.getContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 1, headSha: fixture.headSha,
    }).length, 0);
  } finally {
    queue.close();
  }
});

test('engine fails closed on a foreign producer App without loading artifacts', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, {
    producerChecks: [{
      id: 42,
      name: fixture.producerCheckName,
      head_sha: fixture.headSha,
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-09-07T04:30:00.000Z',
      app: { id: 99999 },
    }],
  });
  const { engine } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.conclusion, 'failure');
    assert.equal(gate.projectionStates[0].reason, 'producer_check_identity_mismatch');
    assert.equal(client.calls.some((call) => call.path.includes('/contents/')), false);
    assert.equal(queue.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 1, headSha: fixture.headSha, projectionKind: 'protobuf',
    })?.result.findings[0].code, 'producer_check_identity_mismatch');
  } finally {
    queue.close();
  }
});

test('engine persists a bounded failure when exact artifact bytes are tampered', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, {
    artifactTexts: {
      [fixture.paths.report]: `${fixture.reportText.trim()} \n`,
    },
  });
  const { engine, logger } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.conclusion, 'failure');
    assert.equal(gate.projectionStates[0].reason, 'report_raw_digest_mismatch');
    const receipt = queue.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 1, headSha: fixture.headSha, projectionKind: 'protobuf',
    });
    assert.equal(receipt?.result.findings[0].code, 'report_raw_digest_mismatch');
    assert.doesNotMatch(JSON.stringify(logger.events), /Example\.User/u);
  } finally {
    queue.close();
  }
});

test('engine rejects fork-head contract evidence before producer or content reads', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, { headRepository: 'ForkOwner/R' });
  const { engine } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.conclusion, 'failure');
    assert.equal(gate.projectionStates[0].reason, 'contract_artifact_fork_unsupported');
    assert.equal(
      client.calls.some((call) => call.path.includes(`check_name=${encodeURIComponent(fixture.producerCheckName)}`)),
      false,
    );
    assert.equal(client.calls.some((call) => call.path.includes('/contents/')), false);
  } finally {
    queue.close();
  }
});

test('transient artifact failures propagate for worker retry without a false receipt', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, { transientPath: fixture.paths.report });
  const { engine } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    await assert.rejects(
      () => engine.process(gateJob(fixture.headSha)),
      (error) => error?.status === 503,
    );
    assert.equal(queue.getContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 1, headSha: fixture.headSha,
    }).length, 0);
    assert.equal(
      client.calls.some((call) => call.method === 'PATCH' && call.options.body?.status === 'completed'),
      false,
    );
  } finally {
    queue.close();
  }
});

test('head movement invalidates old receipts, neutralizes the old gate, and queues the new SHA', async () => {
  const fixture = makeContractAdmissionFixture();
  const newHead = 'b'.repeat(40);
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture, { pullHeads: [fixture.headSha, newHead] });
  const { engine } = createEngine(fixture, client, queue);
  try {
    seedApprovals(queue, fixture.headSha);
    const result = await engine.process(gateJob(fixture.headSha));
    assert.equal(result.skipped, 'head-moved-during-gate');
    assert.equal(result.evaluatedHeadSha, fixture.headSha);
    assert.equal(result.currentHeadSha, newHead);
    assert.equal(queue.getContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 1, headSha: fixture.headSha,
    }).length, 0);

    const replacement = queue.claimNext('worker-2', 30_000);
    assert.equal(replacement?.type, 'gate');
    assert.equal(replacement?.headSha, newHead);
    const neutral = client.calls.find(
      (call) => call.method === 'PATCH' && call.options.body?.conclusion === 'neutral',
    );
    assert.ok(neutral);
    assert.match(neutral.options.body.output.summary, new RegExp(newHead, 'u'));
  } finally {
    queue.close();
  }
});

test('a repository without trusted policy preserves the existing provider and CI gate', async () => {
  const fixture = makeContractAdmissionFixture();
  const queue = new SqliteQueue({ path: ':memory:' });
  const client = fakeClient(fixture);
  const config = activeConfig(fixture);
  config.contractAdmission.policy = validateContractAdmissionPolicy({
    schema: 'ores.gh-bots.contract-admission-policy/v1',
    repositories: [],
  });
  const engine = new ReviewEngine({
    config,
    client,
    auth,
    queue,
    logger: captureLogger(),
    metrics: new Metrics(),
  });
  try {
    seedApprovals(queue, fixture.headSha);
    const gate = await engine.process(gateJob(fixture.headSha));
    assert.equal(gate.conclusion, 'success');
    assert.deepEqual(gate.projectionStates, []);
    assert.equal(client.calls.some((call) => call.path.includes('/contents/')), false);
  } finally {
    queue.close();
  }
});
