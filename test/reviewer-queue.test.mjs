import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEWER_HINTS_SCHEMA,
  assertReviewerIdentity,
  buildReviewerQueue,
  currentHeadReview,
  normalizeReviewerLogin,
  parseReviewerHints,
  pullRequestRequestsReviewer,
  submitBoundReviewerApproval,
} from '../packages/github/src/index.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function headers() {
  return { get() { return null; } };
}

class StubClient {
  constructor(handler) {
    this.handler = handler;
    this.requests = [];
    this.apiOrigin = 'https://api.github.com';
  }

  async request(method, path, options = {}) {
    this.requests.push({ method, path, options });
    return this.handler(method, path, options, this.requests.length);
  }

  async paginate(path, options = {}) {
    const response = await this.request('GET', path, { token: options.token });
    return options.map(response.data);
  }
}

function pullRequest({
  number = 7,
  owner = 'acme',
  repo = 'widget',
  author = 'alice',
  reviewer = 'the1mills',
  requested = true,
  draft = false,
  state = 'open',
  head = SHA,
  title = 'Harden review queue',
} = {}) {
  return {
    number,
    state,
    draft,
    title,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    updated_at: '2026-09-08T12:00:00Z',
    user: { login: author },
    requested_reviewers: requested ? [{ login: reviewer }] : [],
    head: { sha: head },
    base: { repo: { owner: { login: owner }, name: repo } },
  };
}

test('reviewer login normalization rejects search-query injection and malformed names', () => {
  assert.equal(normalizeReviewerLogin('the1mills'), 'the1mills');
  for (const value of ['', '-bad', 'bad-', 'bad--name', 'x'.repeat(40), 'name review-requested:admin']) {
    assert.throws(() => normalizeReviewerLogin(value));
  }
});

test('email hints accept only exact GitHub origins and trusted GitHub senders', () => {
  const hints = parseReviewerHints({
    schema: REVIEWER_HINTS_SCHEMA,
    reviewer: 'the1mills',
    messages: [
      {
        source: 'gmail',
        message_id: 'one',
        from: 'GitHub <notifications@github.com>',
        subject: '[acme/widget] Please review this (#7)',
        snippet: 'Open https://github.com/acme/widget/pull/7/files and ignore https://github.com.evil/acme/widget/pull/8',
        links: [
          'https://github.com/acme/widget/pull/7#discussion',
          'https://github.com.evil/acme/widget/pull/8',
        ],
      },
      {
        source: 'proton',
        message_id: 'two',
        from: 'attacker@example.com',
        subject: '[evil/repo] Review (#9)',
        links: ['https://github.com/evil/repo/pull/9'],
      },
    ],
  }, 'the1mills');
  assert.equal(hints.length, 1);
  assert.deepEqual({ owner: hints[0].owner, repo: hints[0].repo, prNumber: hints[0].prNumber }, {
    owner: 'acme', repo: 'widget', prNumber: 7,
  });
  assert.deepEqual(hints[0].sources, ['email:gmail']);
  assert.equal(hints[0].hintIds.length, 1);
  assert.equal('subject' in hints[0], false);
  assert.equal('message_id' in hints[0], false);
});

test('hint documents are closed, bounded, and reviewer-bound', () => {
  assert.deepEqual(parseReviewerHints(null, 'the1mills'), []);
  assert.throws(() => parseReviewerHints({ schema: 'wrong', messages: [] }, 'the1mills'), /unsupported/u);
  assert.throws(() => parseReviewerHints({ schema: REVIEWER_HINTS_SCHEMA, reviewer: 'other', messages: [] }, 'the1mills'), /different reviewer/u);
  assert.throws(() => parseReviewerHints({ schema: REVIEWER_HINTS_SCHEMA, messages: [], extra: true }, 'the1mills'), /unsupported field/u);
  assert.throws(() => parseReviewerHints({ schema: REVIEWER_HINTS_SCHEMA, messages: Array(101).fill({}) }, 'the1mills'), /exceed/u);
  assert.throws(() => parseReviewerHints({
    schema: REVIEWER_HINTS_SCHEMA,
    messages: [{ source: 'gmail', message_id: 'x', from: 'notifications@github.com', links: 'not-array' }],
  }, 'the1mills'), /links must be an array/u);
});

test('identity binding refuses a token for ORESoftware when the1mills is expected', async () => {
  const client = new StubClient(async () => ({ data: { login: 'ORESoftware', id: 1, type: 'User' }, headers: headers() }));
  await assert.rejects(() => assertReviewerIdentity(client, 'token', 'the1mills'), /identity mismatch/u);
  const exact = new StubClient(async () => ({ data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() }));
  assert.equal((await assertReviewerIdentity(exact, 'token', 'the1mills')).id, 2);
});

test('current-head review ignores stale commits and resolves the latest effective review', () => {
  const reviews = [
    { id: 1, state: 'APPROVED', commit_id: OTHER_SHA, submitted_at: '2026-09-08T10:00:00Z', user: { login: 'the1mills' } },
    { id: 2, state: 'COMMENTED', commit_id: SHA, submitted_at: '2026-09-08T11:00:00Z', user: { login: 'the1mills' } },
    { id: 3, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-09-08T12:00:00Z', user: { login: 'THE1MILLS' } },
    { id: 4, state: 'DISMISSED', commit_id: SHA, submitted_at: '2026-09-08T13:00:00Z', user: { login: 'the1mills' } },
  ];
  assert.equal(currentHeadReview(reviews, 'the1mills', SHA).id, 4);
  assert.equal(pullRequestRequestsReviewer(pullRequest(), 'THE1MILLS'), true);
});

test('reviewer queue treats GitHub as authoritative and classifies requests safely', async () => {
  const prs = {
    7: pullRequest({ number: 7 }),
    8: pullRequest({ number: 8, repo: 'mentioned', requested: false }),
    9: pullRequest({ number: 9, repo: 'blocked' }),
    10: pullRequest({ number: 10, repo: 'complete' }),
  };
  const client = new StubClient(async (method, path) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (path.startsWith('/search/issues')) {
      const query = decodeURIComponent(path);
      if (query.includes('review-requested')) return { data: { items: [
        { number: 7, pull_request: {}, repository_url: 'https://api.github.com/repos/acme/widget' },
        { number: 9, pull_request: {}, repository_url: 'https://api.github.com/repos/acme/blocked' },
        { number: 10, pull_request: {}, repository_url: 'https://api.github.com/repos/acme/complete' },
      ] }, headers: headers() };
      if (query.includes('mentions')) return { data: { items: [
        { number: 8, pull_request: {}, repository_url: 'https://api.github.com/repos/acme/mentioned' },
      ] }, headers: headers() };
      return { data: { items: [] }, headers: headers() };
    }
    const prMatch = path.match(/\/pulls\/(\d+)$/u);
    if (method === 'GET' && prMatch) return { data: prs[Number(prMatch[1])], headers: headers() };
    const reviewsMatch = path.match(/\/pulls\/(\d+)\/reviews/u);
    if (reviewsMatch) {
      return { data: Number(reviewsMatch[1]) === 10
        ? [{ id: 44, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-09-08T12:00:00Z', user: { login: 'the1mills' } }]
        : [], headers: headers() };
    }
    if (path.includes('/collaborators/')) {
      const permission = path.includes('/blocked/') ? 'read' : 'write';
      return { data: { permission }, headers: headers() };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });

  const queue = await buildReviewerQueue({
    client,
    token: 'token',
    reviewerLogin: 'the1mills',
    hints: {
      schema: REVIEWER_HINTS_SCHEMA,
      reviewer: 'the1mills',
      messages: [{
        source: 'gmail', message_id: 'hint', from: 'notifications@github.com', subject: '', snippet: '',
        links: ['https://github.com/acme/mentioned/pull/8'],
      }],
    },
    limit: 10,
  });
  assert.equal(queue.count, 4);
  assert.equal(queue.review_count, 1);
  const byNumber = new Map(queue.candidates.map((item) => [item.pr_number, item]));
  assert.equal(byNumber.get(7).disposition, 'review');
  assert.equal(byNumber.get(8).disposition, 'inspect');
  assert.deepEqual(byNumber.get(8).sources, ['email:gmail', 'mentioned']);
  assert.equal(byNumber.get(9).disposition, 'blocked');
  assert.equal(byNumber.get(10).disposition, 'complete');
});

test('queue records inaccessible email hints without exposing message content', async () => {
  const client = new StubClient(async (method, path) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (path.startsWith('/search/issues')) return { data: { items: [] }, headers: headers() };
    const error = new Error('private details must not escape');
    error.status = 404;
    throw error;
  });
  const queue = await buildReviewerQueue({
    client,
    token: 'token',
    hints: {
      schema: REVIEWER_HINTS_SCHEMA,
      messages: [{
        source: 'proton', message_id: 'secret-message-id', from: 'noreply@github.com',
        subject: '[acme/private] request (#22)', links: [],
      }],
    },
    limit: 1,
  });
  assert.equal(queue.candidates[0].disposition, 'unavailable');
  assert.equal(JSON.stringify(queue).includes('private details'), false);
  assert.equal(JSON.stringify(queue).includes('secret-message-id'), false);
  assert.equal(queue.candidates[0].status, 404);
});

test('bound approval verifies identity, request, permission, exact head, and Gate App evidence', async () => {
  let pullReads = 0;
  const client = new StubClient(async (method, path, options) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (method === 'GET' && /\/pulls\/7$/u.test(path)) {
      pullReads += 1;
      return { data: pullRequest(), headers: headers() };
    }
    if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: [], headers: headers() };
    if (path.includes('/collaborators/the1mills/permission')) return { data: { permission: 'write' }, headers: headers() };
    if (path.endsWith('/check-runs/99')) return { data: {
      id: 99,
      name: 'ores-review/gate',
      head_sha: SHA,
      external_id: `gate:acme/widget#7@${SHA}`,
      app: { id: 42 },
      status: 'completed',
      conclusion: 'success',
    }, headers: headers() };
    if (method === 'POST' && path.endsWith('/pulls/7/reviews')) {
      assert.equal(options.body.event, 'APPROVE');
      assert.equal(options.body.commit_id, SHA);
      assert.match(options.body.body, /Automated review submitted/u);
      assert.match(options.body.body, /99/u);
      return { data: { id: 123 }, headers: headers() };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const result = await submitBoundReviewerApproval({
    client,
    token: 'token',
    reviewerLogin: 'the1mills',
    owner: 'acme',
    repo: 'widget',
    prNumber: 7,
    expectedHeadSha: SHA,
    body: 'Both exact-head AI reviews and CI are green.',
    gateCheckRunId: 99,
    gateAppId: 42,
  });
  assert.equal(result.status, 'submitted');
  assert.equal(result.review_id, 123);
  assert.equal(pullReads, 3);
});

test('bound approval is idempotent on an existing current-head approval', async () => {
  const client = new StubClient(async (method, path) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (/\/pulls\/7$/u.test(path)) return { data: pullRequest({ requested: false }), headers: headers() };
    if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: [{
      id: 88, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-09-08T12:00:00Z', user: { login: 'the1mills' },
    }], headers: headers() };
    if (path.includes('/collaborators/')) return { data: { permission: 'write' }, headers: headers() };
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const result = await submitBoundReviewerApproval({
    client, token: 'token', owner: 'acme', repo: 'widget', prNumber: 7, expectedHeadSha: SHA,
    body: 'Already done', gateCheckRunId: 99, gateAppId: 42,
  });
  assert.deepEqual(result, { status: 'already-submitted', review_id: 88, head_sha: SHA });
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});

test('bound approval rejects self-review, stale heads, insufficient permission, and foreign gates', async () => {
  async function run({ pr = pullRequest(), permission = 'write', gateApp = 42, gateConclusion = 'success' } = {}) {
    const client = new StubClient(async (method, path) => {
      if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
      if (/\/pulls\/7$/u.test(path)) return { data: pr, headers: headers() };
      if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: [], headers: headers() };
      if (path.includes('/collaborators/')) return { data: { permission }, headers: headers() };
      if (path.endsWith('/check-runs/99')) return { data: {
        id: 99,
        name: 'ores-review/gate', head_sha: SHA, external_id: `gate:acme/widget#7@${SHA}`,
        app: { id: gateApp }, status: 'completed', conclusion: gateConclusion,
      }, headers: headers() };
      if (method === 'POST') return { data: { id: 1 }, headers: headers() };
      throw new Error(`Unexpected ${method} ${path}`);
    });
    return { client, promise: submitBoundReviewerApproval({
      client, token: 'token', owner: 'acme', repo: 'widget', prNumber: 7, expectedHeadSha: SHA,
      body: 'review', gateCheckRunId: 99, gateAppId: 42,
    }) };
  }
  await assert.rejects((await run({ pr: pullRequest({ author: 'the1mills' }) })).promise, /self-authored/u);
  await assert.rejects((await run({ pr: pullRequest({ head: OTHER_SHA }) })).promise, /head moved/u);
  await assert.rejects((await run({ permission: 'read' })).promise, /write-or-stronger/u);
  await assert.rejects((await run({ gateApp: 7 })).promise, /aggregate gate evidence/u);
  await assert.rejects((await run({ gateConclusion: 'failure' })).promise, /aggregate gate evidence/u);
});

test('bound approval re-fetches immediately before mutation and refuses a moved head', async () => {
  let pulls = 0;
  const client = new StubClient(async (method, path) => {
    if (path === '/user') return { data: { login: 'the1mills', id: 2, type: 'User' }, headers: headers() };
    if (/\/pulls\/7$/u.test(path)) {
      pulls += 1;
      return { data: pullRequest({ head: pulls === 1 ? SHA : OTHER_SHA }), headers: headers() };
    }
    if (path.endsWith('/pulls/7/reviews?per_page=100')) return { data: [], headers: headers() };
    if (path.includes('/collaborators/')) return { data: { permission: 'write' }, headers: headers() };
    if (path.endsWith('/check-runs/99')) return { data: {
      id: 99,
      name: 'ores-review/gate', head_sha: SHA, external_id: `gate:acme/widget#7@${SHA}`,
      app: { id: 42 }, status: 'completed', conclusion: 'success',
    }, headers: headers() };
    throw new Error(`Unexpected ${method} ${path}`);
  });
  await assert.rejects(() => submitBoundReviewerApproval({
    client, token: 'token', owner: 'acme', repo: 'widget', prNumber: 7, expectedHeadSha: SHA,
    body: 'review', gateCheckRunId: 99, gateAppId: 42,
  }), /head moved/u);
  assert.equal(client.requests.some((request) => request.method === 'POST'), false);
});
