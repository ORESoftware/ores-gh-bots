import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Directories never descended into. `dd` and `dd-next-1` are excluded from all
 * automated agent work by standing request (chat #89); `_to_delete` is the
 * sink for files this environment cannot unlink; the rest are build output and
 * vendored trees that can contain nested .git dirs we must not treat as fleet
 * repos.
 */
export const SKIP_DIRS: readonly string[] = [
  'dd',
  'dd-next-1',
  '_to_delete',
  '.worktrees',
  'node_modules',
  'target',
  'vendor',
  'dist',
  'build',
  '.git',
  'Pods',
  '.venv',
  'venv',
];

export interface FoundRepo {
  readonly path: string;
  readonly name: string;
  /** A repo checked out as a git worktree shares its parent's config. */
  readonly isWorktree: boolean;
}

/**
 * Finds git repositories under `root`, depth-first but not descending into a
 * repo once found — nested repos are almost always submodules or vendored
 * copies, and rewriting their .gitignore would dirty someone else's tree.
 */
export function findRepos(root: string, maxDepth = 3): FoundRepo[] {
  const out: FoundRepo[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes('.git')) {
      let isWorktree = false;
      try {
        // A worktree's .git is a file containing `gitdir: …`, not a directory.
        isWorktree = statSync(join(dir, '.git')).isFile();
      } catch {
        /* treat as a normal repo */
      }
      out.push({ path: dir, name: basename(dir), isWorktree });
      return; // do not descend into a repo
    }
    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry) || entry.startsWith('.')) continue;
      let isDir = false;
      try {
        isDir = statSync(join(dir, entry)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(join(dir, entry), depth + 1);
    }
  };

  walk(root, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
