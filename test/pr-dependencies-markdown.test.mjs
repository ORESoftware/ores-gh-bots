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

test('ignores fenced, indented, and HTML-comment dependency examples', () => {
  const parsed = parsePullRequestDependencies([
    'Depends on: Org/Real#1 @ v1.0.0',
    '',
    '```text',
    'Depends on: Org/Example#2 @ v9.9.9',
    '```',
    '',
    '    Depends on: Org/IndentedExample#3',
    '',
    '<!--',
    'Depends on: Org/HiddenExample#4',
    '-->',
    '',
    '<!-- Depends on: Org/InlineHidden#5 -->',
    '',
    '~~~md',
    '- Depends on: Org/TildeExample#6',
    '~~~~',
  ].join('\n'), { owner: 'Org', repo: 'App' });

  assert.deepEqual(parsed.map((item) => [item.key, item.expectedVersion]), [
    ['org/real#1', '1.0.0'],
  ]);
});
