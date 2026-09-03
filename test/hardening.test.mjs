import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectPullRequestFiles } from '../packages/core/src/index.mjs';
import { buildReviewContext } from '../packages/engine/src/context.mjs';
import { GitHubClient } from '../packages/github/src/index.mjs';

const reviewConfig = { maxFiles: 10, maxFileBytes: 100, maxDiffBytes: 150, timeoutMs: 1_000, maxFindings: 10 };
const pullRequest = {
  number: 1,
  title: 'x',
  body: '',
  user: { login: 'u' },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
  head: { ref: 'feature', sha: 'abc' },
  additions: 1,
  deletions: 0,
  changed_files: 1,
};

test('incomplete pull-request diff coverage fails closed before provider review', () => {
  const collected = collectPullRequestFiles([
    { filename: 'a.js', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: 'x'.repeat(200) },
    { filename: 'asset.bin', status: 'added', additions: 0, deletions: 0, changes: 0 },
  ], reviewConfig);
  assert.equal(collected.collection.complete, false);
  assert.throws(
    () => buildReviewContext({ pullRequest, files: [
      { filename: 'a.js', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: 'x'.repeat(200) },
      { filename: 'asset.bin', status: 'added', additions: 0, deletions: 0, changes: 0 },
    ], reviewConfig }),
    /diff coverage is incomplete/,
  );
});

test('complete pull-request diff coverage remains reviewable', () => {
  const result = buildReviewContext({
    pullRequest,
    files: [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+ok' }],
    reviewConfig: { ...reviewConfig, maxFileBytes: 1_000, maxDiffBytes: 1_000 },
  });
  assert.equal(result.collection.complete, true);
});

test('GitHub client refuses bearer forwarding to a different absolute origin', async () => {
  const client = new GitHubClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(
    client.request('GET', 'https://attacker.example/page', { token: 'secret' }),
    /different origin/,
  );
});

test('GitHub requests reject implicit redirects before credentials can move', async () => {
  let requestOptions;
  const client = new GitHubClient({
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await client.request('GET', '/user', { token: 'secret', retries: 0 });
  assert.equal(requestOptions.redirect, 'error');
});

test('review-dispatch keeps untrusted workflow inputs out of shell source', async () => {
  const workflow = await readFile(new URL('../.github/workflows/review-dispatch.yml', import.meta.url), 'utf8');
  const runBlock = workflow.slice(workflow.indexOf('- name: Review exact pull-request head'));
  assert.match(runBlock, /REVIEW_OWNER: \$\{\{ inputs\.owner \}\}/);
  assert.match(runBlock, /run: node apps\/runner\/src\/main\.mjs/);
  assert.doesNotMatch(runBlock, /--owner .*inputs\.owner/);
  assert.doesNotMatch(runBlock, /--reason .*inputs\.reason/);
});
