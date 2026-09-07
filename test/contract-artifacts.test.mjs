import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRepositoryTextFileAtCommit,
  inspectProjectionProducerCheck,
} from '../packages/github/src/contract-artifacts.mjs';

const headSha = 'a'.repeat(40);
const artifactPath = 'contracts/evidence/report.json';

function contentClient(overrides = {}) {
  const text = overrides.text ?? '{"ok":true}\n';
  const bytes = overrides.bytes ?? Buffer.from(text, 'utf8');
  const artifact = {
    type: 'file',
    path: artifactPath,
    sha: 'b'.repeat(40),
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
    ...overrides.artifact,
  };
  const calls = [];
  return {
    calls,
    async request(method, path) {
      calls.push({ method, path });
      return { data: artifact };
    },
  };
}

test('fetches one UTF-8 artifact from the exact commit without redirects', async () => {
  const client = contentClient();
  const result = await fetchRepositoryTextFileAtCommit(
    client,
    'token',
    'Example',
    'Widget',
    artifactPath,
    headSha,
    { maxBytes: 1024 },
  );
  assert.equal(result.text, '{"ok":true}\n');
  assert.equal(result.blobSha, 'b'.repeat(40));
  assert.equal(Object.isFrozen(result), true);
  assert.match(client.calls[0].path, /contents\/contracts\/evidence\/report\.json\?ref=a{40}$/u);
});

test('rejects unsafe paths, directories, oversized metadata, and byte-count drift', async () => {
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(contentClient(), 'token', 'O', 'R', '../report.json', headSha, { maxBytes: 1024 }),
    /unsafe segment/u,
  );
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      contentClient({ artifact: { type: 'dir' } }),
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 1024 },
    ),
    /not one regular repository file/u,
  );
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      contentClient({ artifact: { size: 2048 } }),
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 1024 },
    ),
    /exceeds the configured byte boundary/u,
  );
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      contentClient({ artifact: { size: 2 } }),
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 1024 },
    ),
    /byte length does not match/u,
  );
});

test('rejects invalid base64 and non-UTF-8 artifacts', async () => {
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      contentClient({ artifact: { content: '***', size: 3 } }),
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 1024 },
    ),
    /invalid base64/u,
  );
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  await assert.rejects(
    () => fetchRepositoryTextFileAtCommit(
      contentClient({ bytes: invalidUtf8 }),
      'token',
      'O',
      'R',
      artifactPath,
      headSha,
      { maxBytes: 1024 },
    ),
    /not valid UTF-8/u,
  );
});

function checkClient(checkRuns) {
  const calls = [];
  return {
    calls,
    async request(method, path) {
      calls.push({ method, path });
      return { data: { check_runs: checkRuns } };
    },
  };
}

function producerCheck(overrides = {}) {
  return {
    id: 42,
    name: 'contract-parity/verify',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-09-07T04:00:00.000Z',
    app: { id: 12345 },
    ...overrides,
  };
}

const checkPolicy = {
  checkName: 'contract-parity/verify',
  checkAppId: 12345,
  maxCheckAgeSeconds: 24 * 60 * 60,
  nowMs: Date.parse('2026-09-07T05:00:00.000Z'),
};

test('keeps a missing or in-progress producer check pending', async () => {
  const missing = await inspectProjectionProducerCheck(
    checkClient([]), 'token', 'O', 'R', headSha, checkPolicy,
  );
  assert.equal(missing.state, 'pending');
  assert.equal(missing.code, 'producer_check_missing');

  const pending = await inspectProjectionProducerCheck(
    checkClient([producerCheck({ status: 'in_progress', conclusion: null, completed_at: null })]),
    'token',
    'O',
    'R',
    headSha,
    checkPolicy,
  );
  assert.equal(pending.state, 'pending');
  assert.equal(pending.checkRunId, 42);
});

test('rejects foreign, stale, expired, and unsuccessful producer checks', async () => {
  const foreign = await inspectProjectionProducerCheck(
    checkClient([producerCheck({ app: { id: 999 } })]), 'token', 'O', 'R', headSha, checkPolicy,
  );
  assert.equal(foreign.code, 'producer_check_identity_mismatch');

  const stale = await inspectProjectionProducerCheck(
    checkClient([producerCheck({ head_sha: 'c'.repeat(40) })]), 'token', 'O', 'R', headSha, checkPolicy,
  );
  assert.equal(stale.code, 'producer_check_head_mismatch');

  const expired = await inspectProjectionProducerCheck(
    checkClient([producerCheck({ completed_at: '2026-09-05T04:00:00.000Z' })]),
    'token',
    'O',
    'R',
    headSha,
    checkPolicy,
  );
  assert.equal(expired.code, 'producer_check_expired');

  const failed = await inspectProjectionProducerCheck(
    checkClient([producerCheck({ conclusion: 'failure' })]), 'token', 'O', 'R', headSha, checkPolicy,
  );
  assert.equal(failed.code, 'producer_check_not_successful');
});

test('selects the latest expected-App check and returns an expiry boundary', async () => {
  const client = checkClient([
    producerCheck({ id: 40, app: { id: 999 } }),
    producerCheck({ id: 41, completed_at: '2026-09-07T03:00:00.000Z' }),
    producerCheck({ id: 43, completed_at: '2026-09-07T04:30:00.000Z' }),
  ]);
  const result = await inspectProjectionProducerCheck(client, 'token', 'O', 'R', headSha, checkPolicy);
  assert.equal(result.state, 'success');
  assert.equal(result.checkRunId, 43);
  assert.equal(result.expiresAt, Date.parse('2026-09-08T04:30:00.000Z'));
  assert.match(client.calls[0].path, /filter=all&per_page=100$/u);
});
