/**
 * Idempotent .gitignore maintenance for the local fleet.
 *
 * Chat request #78 (DEN-3956): every repo under ~/codes should ignore the
 * scratch and worktree directories, so agent runs stop offering them up as
 * untracked noise in `git status`.
 *
 * The patterns go inside a delimited managed block rather than being appended
 * loose. Appending loose is what makes this kind of script un-runnable twice:
 * the second run either duplicates the lines or has to guess which trailing
 * lines it wrote. A marked block can be located, compared, and rewritten.
 */

export const BLOCK_START = '# >>> ores fleet hygiene — managed block, edits below are overwritten >>>';
export const BLOCK_END = '# <<< ores fleet hygiene <<<';

/** Exactly what chat #78 asked to ignore. */
export const MANAGED_PATTERNS: readonly string[] = ['tmp/temp/', 'tmp/worktrees/'];

export interface PatchResult {
  readonly changed: boolean;
  readonly content: string;
  readonly reason: 'created' | 'block-added' | 'block-updated' | 'already-current' | 'already-ignored';
}

function renderBlock(patterns: readonly string[]): string {
  return [BLOCK_START, ...patterns, BLOCK_END].join('\n');
}

/**
 * True when a pattern is already honoured by an existing, unmanaged line.
 * `tmp/` covers `tmp/temp/`, and a bare `tmp` covers it too — re-adding the
 * narrower pattern under those would be noise, not correctness.
 */
export function alreadyCovered(existingLines: readonly string[], pattern: string): boolean {
  const target = pattern.replace(/\/+$/, '');
  for (const raw of existingLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // a negation never grants coverage
    const normalised = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalised) continue;
    if (normalised === target) return true;
    // A parent directory ignore subsumes anything beneath it.
    if (target.startsWith(normalised + '/')) return true;
  }
  return false;
}

export function patchGitignore(existing: string | null): PatchResult {
  const lines = existing === null ? [] : existing.split(/\r?\n/);

  const startIdx = lines.findIndex((l) => l.trim() === BLOCK_START);
  const endIdx = lines.findIndex((l) => l.trim() === BLOCK_END);
  const hasBlock = startIdx !== -1 && endIdx > startIdx;

  const outsideBlock = hasBlock ? [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)] : lines;

  const needed = MANAGED_PATTERNS.filter((p) => !alreadyCovered(outsideBlock, p));

  // Every pattern is already handled by the repo's own rules — leave it alone
  // rather than planting a redundant managed block.
  if (needed.length === 0) {
    if (!hasBlock) return { changed: false, content: existing ?? '', reason: 'already-ignored' };
    // Block is present but now redundant; still leave it, removing it would
    // churn repos for no benefit.
    return { changed: false, content: existing ?? '', reason: 'already-current' };
  }

  const block = renderBlock(needed);

  if (hasBlock) {
    const current = lines.slice(startIdx, endIdx + 1).join('\n');
    if (current === block) return { changed: false, content: existing ?? '', reason: 'already-current' };
    const rebuilt = [...lines.slice(0, startIdx), ...block.split('\n'), ...lines.slice(endIdx + 1)];
    return { changed: true, content: ensureTrailingNewline(rebuilt.join('\n')), reason: 'block-updated' };
  }

  if (existing === null) {
    return { changed: true, content: ensureTrailingNewline(block), reason: 'created' };
  }

  const base = existing.replace(/\s*$/, '');
  const joined = base.length ? `${base}\n\n${block}` : block;
  return { changed: true, content: ensureTrailingNewline(joined), reason: 'block-added' };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}
