import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_END,
  BLOCK_START,
  MANAGED_PATTERNS,
  alreadyCovered,
  patchGitignore,
} from '../src/hygiene/gitignore.ts';
import { findRepos } from '../src/hygiene/scan.ts';

describe('gitignore patching', () => {
  test('creates a file when none exists', () => {
    const r = patchGitignore(null);
    assert.equal(r.reason, 'created');
    assert.ok(r.changed);
    for (const p of MANAGED_PATTERNS) assert.ok(r.content.includes(p));
    assert.ok(r.content.endsWith('\n'));
  });

  test('appends a managed block to an existing file without disturbing it', () => {
    const r = patchGitignore('node_modules/\ndist/\n');
    assert.equal(r.reason, 'block-added');
    assert.ok(r.content.startsWith('node_modules/\ndist/'));
    assert.ok(r.content.includes(BLOCK_START));
    assert.ok(r.content.includes(BLOCK_END));
  });

  test('is idempotent — a second run changes nothing', () => {
    const first = patchGitignore('node_modules/\n');
    const second = patchGitignore(first.content);
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already-current');
    assert.equal(second.content, first.content);
  });

  test('running it three times does not duplicate the block', () => {
    let content = 'a\n';
    for (let i = 0; i < 3; i++) content = patchGitignore(content).content || content;
    const starts = content.split(BLOCK_START).length - 1;
    assert.equal(starts, 1, 'managed block must appear exactly once');
  });

  test('rewrites a stale managed block in place rather than appending a second', () => {
    const stale = ['x/', BLOCK_START, 'tmp/old-thing/', BLOCK_END, 'y/'].join('\n');
    const r = patchGitignore(stale);
    assert.equal(r.reason, 'block-updated');
    assert.equal(r.content.split(BLOCK_START).length - 1, 1);
    assert.ok(r.content.includes('y/'), 'content after the block must survive');
    assert.ok(r.content.startsWith('x/'), 'content before the block must survive');
    assert.ok(!r.content.includes('tmp/old-thing/'));
  });

  test('leaves a repo alone when a broader rule already covers the patterns', () => {
    const r = patchGitignore('tmp/\n');
    assert.equal(r.changed, false);
    assert.equal(r.reason, 'already-ignored');
  });

  test('adds only the patterns not already covered', () => {
    const r = patchGitignore('tmp/worktrees/\n');
    assert.ok(r.changed);
    assert.ok(r.content.includes('tmp/temp/'));
    const block = r.content.slice(r.content.indexOf(BLOCK_START), r.content.indexOf(BLOCK_END));
    assert.ok(!block.includes('tmp/worktrees/'), 'covered pattern must not be re-added');
  });

  test('coverage rules', () => {
    assert.ok(alreadyCovered(['tmp/'], 'tmp/temp/'), 'parent dir covers child');
    assert.ok(alreadyCovered(['tmp'], 'tmp/temp/'), 'bare parent covers child');
    assert.ok(alreadyCovered(['/tmp/temp'], 'tmp/temp/'), 'leading slash is the same rule');
    assert.ok(!alreadyCovered(['tmpfoo/'], 'tmp/temp/'), 'prefix is not a parent');
    assert.ok(!alreadyCovered(['# tmp/'], 'tmp/temp/'), 'comments grant nothing');
    assert.ok(!alreadyCovered(['!tmp/'], 'tmp/temp/'), 'negation grants nothing');
    assert.ok(!alreadyCovered([''], 'tmp/temp/'));
  });

  test('a file with no trailing newline is joined cleanly', () => {
    const r = patchGitignore('node_modules/');
    assert.ok(!r.content.includes('node_modules/#'), 'must not glue the comment onto the last line');
    assert.ok(r.content.includes('node_modules/\n\n' + BLOCK_START));
  });
});

describe('repo discovery', () => {
  test('finds repos, skips excluded dirs, and does not descend into a repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-'));
    const mk = (p: string, git = false) => {
      mkdirSync(join(root, p), { recursive: true });
      if (git) mkdirSync(join(root, p, '.git'), { recursive: true });
    };
    mk('org-a/repo-1', true);
    mk('org-a/repo-2', true);
    mk('org-a/repo-1/vendor/nested', true); // nested repo inside a repo
    mk('dd/secret-repo', true); // excluded by standing request
    mk('_to_delete/old-repo', true);
    mk('node_modules/pkg', true);
    mk('org-b/not-a-repo');

    const found = findRepos(root).map((r) => r.path.slice(root.length + 1));
    assert.deepEqual(found.sort(), ['org-a/repo-1', 'org-a/repo-2']);
  });

  test('identifies a worktree by its .git being a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wt-'));
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const found = findRepos(root);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.isWorktree, true);
  });
});
