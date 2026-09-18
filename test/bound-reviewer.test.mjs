import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBoundReviewerIdentity,
  currentBoundReviewerHeadReview,
  findSuccessfulBoundReviewerGate,
  submitBoundReviewerApproval,
} from '../packages/github/src/index.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

class StubClient {
  constructor(handler) {
    this.handler = handler;
    this.requests = [];
  }

  async request(method, path, options = {}) {
    this.requests.push({ method, path, options });
    return this.handler(method, path, options);
  }

  async paginate(path, options = {}) {
    const response = await this.request('GET', path, { token: options.token });
    return options.map(response.data);
  }
}

function pullRequest({
  head = SHA,
  author = 'alice',
  requested = true,
  state = 'open',
  draft = false,
} = {}) {
  return {
    number: 7,
    state,
    draft,
    user: { login: author },
    requested_reviewers: requested ? [{ login: 'the1mills' }] : [],
    head: { sha: head },
  };
}

function gate({
  id = 99,
  head = SHA,
  appId = 42,
  externalId = `gate:acme/widget#7@${SHA}`,
  status = 'completed',
  conclusion = 'success',
  name = 'ores-review/gate',
} = {}) {
  return {
    id,
    name,
    head_sha: head,
    app: { id: appId },
    external_id: externalId,
    status,
    conclusion,
  };
}

function standardClient({
  prFactory = () => pullRequest(),
  reviews = () => [],
  permission = 'write',
  gateFactory = () => gate(),
} = {}) {
  let pullReads = 0;
  const client = new StubClient(async (method, path, options) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' } };
    if (method === 'GET' && /\/pulls\/7$/u.test(path)) {
      pullReads += 1;
      return { data: prFactory(pullReads) };
    }
    if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: reviews() };
    if (path.includes('/collaborators/the1mills/permission')) return { data: { permission } };
    if (path.endsWith('/check-runs/99')) return { data: gateFactory() };
    if (method === 'POST' && path.endsWith('/pulls/7/reviews')) {
      return { data: { id: 123, ...options.body } };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return { client, pullReads: () => pullReads };
}

function approvalArgs(client, overrides = {}) {
  return {
    client,
    token: 'reviewer-token',
    reviewerLogin: 'the1mills',
    owner: 'acme',
    repo: 'widget',
    prNumber: 7,
    expectedHeadSha: SHA,
    body: 'Exact-head provider reviews and CI are green.',
    gateCheckRunId: 99,
    gateAppId: 42,
    ...overrides,
  };
}

test('bound reviewer identity must match the configured human user', async () => {
  const good = new StubClient(async () => ({ data: { login: 'the1mills', id: 2, type: 'User' } }));
  assert.deepEqual(
    await assertBoundReviewerIdentity(good, 'token', 'the1mills'),
    { login: 'the1mills', id: 2, type: 'User' },
  );

  const wrong = new StubClient(async () => ({ data: { login: 'ORESoftware', id: 3, type: 'User' } }));
  await assert.rejects(
    () => assertBoundReviewerIdentity(wrong, 'token', 'the1mills'),
    /identity mismatch/u,
  );

  const bot = new StubClient(async () => ({ data: { login: 'the1mills', id: 4, type: 'Bot' } }));
  await assert.rejects(
    () => assertBoundReviewerIdentity(bot, 'token', 'the1mills'),
    /identity mismatch/u,
  );
});

test('current-head review ignores comments that arrive after an effective review', () => {
  const reviews = [
    {
      id: 1,
      state: 'APPROVED',
      commit_id: SHA,
      submitted_at: '2026-09-17T20:00:00Z',
      user: { login: 'the1mills' },
    },
    {
      id: 2,
      state: 'COMMENTED',
      commit_id: SHA,
      submitted_at: '2026-09-17T21:00:00Z',
      user: { login: 'the1mills' },
    },
  ];
  assert.equal(currentBoundReviewerHeadReview(reviews, 'the1mills', SHA).state, 'APPROVED');
});

test('bound approval verifies identity, request, permission, exact gate, and exact head', async () => {
  const { client, pullReads } = standardClient();
  const result = await submitBoundReviewerApproval(approvalArgs(client));
  assert.deepEqual(result, { status: 'submitted', review_id: 123, head_sha: SHA });
  assert.equal(pullReads(), 3);

  const post = client.requests.find((request) => request.method === 'POST');
  assert.equal(post.options.body.event, 'APPROVE');
  assert.equal(post.options.body.commit_id, SHA);
  assert.match(post.options.body.body, /successful aggregate gate check run `99`/u);
});

test('existing current-head approval is idempotent and does not post again', async () => {
  const { client } = standardClient({
    reviews: () => [{
      id: 88,
      state: 'APPROVED',
      commit_id: SHA,
      submitted_at: '2026-09-17T20:00:00Z',
      user: { login: 'the1mills' },
    }],
  });
  const result = await submitBoundReviewerApproval(approvalArgs(client));
  assert.deepEqual(result, { status: 'already-submitted', review_id: 88, head_sha: SHA });
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});

test('current-head change request is an explicit automation veto', async () => {
  const { client } = standardClient({
    reviews: () => [{
      id: 89,
      state: 'CHANGES_REQUESTED',
      commit_id: SHA,
      submitted_at: '2026-09-17T20:00:00Z',
      user: { login: 'the1mills' },
    }],
  });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /requested changes/u,
  );
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});

test('self-authored pull requests can never receive an automated bound approval', async () => {
  const { client } = standardClient({ prFactory: () => pullRequest({ author: 'the1mills' }) });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /self-authored/u,
  );
});

test('moved heads are rejected before gate verification', async () => {
  const { client } = standardClient({ prFactory: () => pullRequest({ head: OTHER_SHA }) });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /head moved/u,
  );
  assert.equal(client.requests.some((request) => request.path.endsWith('/check-runs/99')), false);
});

test('reviewer must still be explicitly requested', async () => {
  const { client } = standardClient({ prFactory: () => pullRequest({ requested: false }) });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /no longer requested/u,
  );
});

test('reviewer needs write-or-stronger permission for a counting approval', async () => {
  const { client } = standardClient({ permission: 'read' });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /write-or-stronger/u,
  );
});

for (const [label, badGate] of [
  ['wrong App', gate({ appId: 7 })],
  ['wrong name', gate({ name: 'build' })],
  ['wrong head', gate({ head: OTHER_SHA })],
  ['wrong external id', gate({ externalId: `gate:acme/other#7@${SHA}` })],
  ['in progress', gate({ status: 'in_progress', conclusion: null })],
  ['failed', gate({ conclusion: 'failure' })],
]) {
  test(`bound approval rejects ${label} gate evidence`, async () => {
    const { client } = standardClient({ gateFactory: () => badGate });
    await assert.rejects(
      () => submitBoundReviewerApproval(approvalArgs(client)),
      /aggregate gate evidence/u,
    );
    assert.equal(client.requests.some((request) => request.method === 'POST'), false);
  });
}

test('mutable authorization inputs are re-read after gate verification', async () => {
  const { client } = standardClient({
    prFactory: (read) => pullRequest({ requested: read < 2 }),
  });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /no longer requested/u,
  );
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});

test('head movement immediately before mutation prevents approval', async () => {
  const { client } = standardClient({
    prFactory: (read) => pullRequest({ head: read === 1 ? SHA : OTHER_SHA }),
  });
  await assert.rejects(
    () => submitBoundReviewerApproval(approvalArgs(client)),
    /head moved/u,
  );
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});

test('post-approval head movement is reported as stale rather than current approval', async () => {
  const { client } = standardClient({
    prFactory: (read) => pullRequest({ head: read >= 3 ? OTHER_SHA : SHA }),
  });
  const result = await submitBoundReviewerApproval(approvalArgs(client));
  assert.deepEqual(result, { status: 'submitted-to-stale-head', review_id: 123, head_sha: SHA });
});

test('gate discovery returns only exact-head success from the configured Gate App', async () => {
  const checks = [
    gate({ id: 90, appId: 7 }),
    gate({ id: 91, head: OTHER_SHA }),
    gate({ id: 92, conclusion: 'failure' }),
    gate({ id: 93 }),
    gate({ id: 94 }),
  ];
  const client = new StubClient(async (method, path) => {
    assert.equal(method, 'GET');
    assert.match(path, /check-runs\?/u);
    return { data: { check_runs: checks } };
  });
  const found = await findSuccessfulBoundReviewerGate({
    client,
    token: 'token',
    owner: 'acme',
    repo: 'widget',
    prNumber: 7,
    headSha: SHA,
    gateAppId: 42,
  });
  assert.equal(found.id, 94);
});

test('gate discovery returns null when no exact trusted success exists', async () => {
  const client = new StubClient(async () => ({
    data: { check_runs: [gate({ appId: 7 }), gate({ conclusion: 'failure' })] },
  }));
  const found = await findSuccessfulBoundReviewerGate({
    client,
    token: 'token',
    owner: 'acme',
    repo: 'widget',
    prNumber: 7,
    headSha: SHA,
    gateAppId: 42,
  });
  assert.equal(found, null);
});
