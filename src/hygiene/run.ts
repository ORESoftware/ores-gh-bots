import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepos, type FoundRepo } from './scan.ts';
import { patchGitignore } from './gitignore.ts';

export interface RepoOutcome {
  readonly repo: string;
  readonly action: 'patched' | 'patched+committed' | 'already-ok' | 'skipped-worktree' | 'failed';
  readonly reason: string;
}

export interface HygieneOptions {
  readonly root: string;
  readonly apply: boolean;
  readonly commit: boolean;
  /** Where un-deletable git lock files are parked; see sweepGitLocks. */
  readonly cruftSink: string | null;
}

const COMMIT_MESSAGE = `chore: ignore tmp/temp and tmp/worktrees (DEN-3956)

Agent runs and git worktrees write into tmp/, and the resulting untracked
entries show up in every subsequent \`git status\`, which makes real changes
harder to see and invites them being swept into unrelated commits.

Added inside a delimited managed block so the fleet pass is idempotent: it can
locate what it wrote previously, compare it, and rewrite it, instead of
appending duplicate lines on every run. Repos whose own rules already cover
these paths were left untouched.

Requested in alex-alex-me chat #78.`;

/**
 * This environment's mounted filesystem refuses `unlink`, so git leaves its
 * `.lock` files behind and the *next* git command in that repo fails with
 * "unable to create ... File exists". Parking them elsewhere is the only
 * available cleanup, so it runs after every git invocation.
 */
export function sweepGitLocks(repoPath: string, sink: string | null): number {
  const gitDir = join(repoPath, '.git');
  let swept = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.endsWith('.lock') && !entry.startsWith('tmp_obj_')) continue;
      try {
        rmSync(full);
        swept++;
        continue;
      } catch {
        /* unlink forbidden — fall through to the sink */
      }
      if (!sink) continue;
      try {
        mkdirSync(sink, { recursive: true });
        renameSync(full, join(sink, `${entry}.${process.pid}.${swept}`));
        swept++;
      } catch {
        /* nothing further we can do; the next git call will report it */
      }
    }
  };
  try {
    if (statSync(gitDir).isDirectory()) visit(gitDir, 0);
  } catch {
    /* worktree or missing .git */
  }
  return swept;
}

function git(repo: string, args: string[], sink: string | null): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    sweepGitLocks(repo, sink);
  }
}

export function processRepo(repo: FoundRepo, opts: HygieneOptions): RepoOutcome {
  // A worktree shares its parent checkout's .gitignore; patching it here would
  // write the same change twice and dirty a tree the parent pass also touches.
  if (repo.isWorktree) {
    return { repo: repo.path, action: 'skipped-worktree', reason: 'shares parent checkout' };
  }

  const path = join(repo.path, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const result = patchGitignore(existing);

  if (!result.changed) {
    return { repo: repo.path, action: 'already-ok', reason: result.reason };
  }
  if (!opts.apply) {
    return { repo: repo.path, action: 'patched', reason: `${result.reason} (dry run)` };
  }

  try {
    writeFileSync(path, result.content, 'utf8');
  } catch (err) {
    return { repo: repo.path, action: 'failed', reason: `write failed: ${String(err)}` };
  }

  if (!opts.commit) {
    return { repo: repo.path, action: 'patched', reason: result.reason };
  }

  try {
    // Stage ONLY .gitignore. These repos routinely carry unrelated work in
    // progress and sweeping it into this commit would be unforgivable.
    git(repo.path, ['add', '--', '.gitignore'], opts.cruftSink);
    const staged = git(repo.path, ['diff', '--cached', '--name-only'], opts.cruftSink).trim();
    if (staged !== '.gitignore') {
      return { repo: repo.path, action: 'failed', reason: `unexpected staged set: "${staged}"` };
    }
    git(
      repo.path,
      // `-m` must precede the `--` pathspec separator; placing it after makes
      // git read the message as another path and the commit fails.
      ['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com',
       'commit', '--no-gpg-sign', '--only', '-m', COMMIT_MESSAGE, '--', '.gitignore'],
      opts.cruftSink,
    );
    return { repo: repo.path, action: 'patched+committed', reason: result.reason };
  } catch (err) {
    return { repo: repo.path, action: 'failed', reason: `commit failed: ${gitErrorText(err)}` };
  }
}

/** execFileSync hides the useful part of a git failure in `stderr`, not `message`. */
function gitErrorText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  if (stderr) return stderr.split('\n').slice(0, 2).join(' / ');
  return (e?.message ?? String(err)).split('\n')[0] ?? 'unknown';
}

export function run(opts: HygieneOptions): RepoOutcome[] {
  return findRepos(opts.root).map((repo) => processRepo(repo, opts));
}

export function tally(outcomes: readonly RepoOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o.action] = (counts[o.action] ?? 0) + 1;
  return counts;
}
