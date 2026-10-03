import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewContext } from '../packages/engine/src/index.mjs';

test('builds an exact-head review context', () => {
  const context = buildReviewContext({
    pullRequest: {
      number: 7, title: 'Change', body: 'Body', draft: false, additions: 2, deletions: 1, changed_files: 1,
      user: { login: 'alex' }, base: { ref: 'main', repo: { full_name: 'o/r' } }, head: { ref: 'feature', sha: 'abc' },
    },
    files: [{ filename: 'a.js', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -1 +1 @@' }],
    reviewConfig: { maxFiles: 10, maxFileBytes: 1000, maxDiffBytes: 10000, timeoutMs: 5000, maxFindings: 10 },
  });
  assert.equal(context.headSha, 'abc');
  assert.equal(context.repository, 'o/r');
  assert.equal(context.files[0].path, 'a.js');
});
