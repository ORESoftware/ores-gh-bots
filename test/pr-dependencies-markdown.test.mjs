import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequestDependencies } from '../packages/core/src/index.mjs';

test('accepts bullet and checkbox dependency directives from PR templates', () => {
  const parsed = parsePullRequestDependencies([
    '- Depends on: Org/Lib#9 @ v2.0.0',
    '- [ ] Requires: #10',
    '* [x] stacked-on: https://github.com/Other/Repo/pull/11',
  ].join('\n'), { owner: 'Org', repo: 'App' });

  assert.deepEqual(parsed.map((item) => [item.key, item.expectedVersion]), [
    ['org/app#10', null],
    ['org/lib#9', '2.0.0'],
    ['other/repo#11', null],
  ]);
});
