import { CONFLICT_CONTEXT_COMMITS_MAX, CONFLICT_CONTEXT_COMMITS_MIN } from './config.ts';

/**
 * Conflict policy.
 *
 * The standing instruction across every org is: resolve conflicts semantically,
 * with full context, looking back 3-10 commits for intent — never hastily pick a
 * side. This module encodes that as a hard invariant rather than a convention:
 * the merge strategies that pick sides are rejected in code, and a conflicted PR
 * produces a dossier for a semantic resolver instead of a mechanical resolution.
 */

/** Merge strategies that resolve a conflict by discarding one side wholesale. */
export const SIDE_PICKING_STRATEGIES = [
  'ours',
  'theirs',
  'union',
  '-X ours',
  '-X theirs',
  '--strategy-option=ours',
  '--strategy-option=theirs',
  '-s ours',
] as const;

export class SidePickingRejected extends Error {
  readonly strategy: string;

  constructor(strategy: string) {
    super(
      `refusing merge strategy "${strategy}": conflicts must be resolved conceptually with full context, ` +
        `not by discarding one side. See docs/policy.md.`,
    );
    this.name = 'SidePickingRejected';
    this.strategy = strategy;
  }
}

/** Throws if the requested strategy would resolve a conflict by picking a side. */
export function assertNotSidePicking(strategy: string): void {
  const normalised = strategy.trim().toLowerCase();
  for (const banned of SIDE_PICKING_STRATEGIES) {
    if (normalised === banned || normalised.includes(banned.toLowerCase())) {
      throw new SidePickingRejected(strategy);
    }
  }
}

export interface ConflictDossier {
  readonly repo: string;
  readonly prNumber: number;
  readonly headRef: string;
  readonly baseRef: string;
  /** Files GitHub reports as touched by the PR; the conflict lives among these. */
  readonly touchedFiles: readonly string[];
  /** Repos in the dependency graph that moved and may explain the conflict. */
  readonly disturbedBy: readonly string[];
  /** How many commits of history a resolver should read on each side. */
  readonly contextCommits: number;
  readonly relatedPulls: readonly number[];
  readonly createdAt: string;
}

/**
 * Scales history depth with how entangled the conflict looks: a single-file
 * conflict with a quiet graph needs the floor, a wide one with dependency
 * movement needs the ceiling.
 */
export function contextDepth(touchedFiles: number, disturbedRepos: number, relatedPulls: number): number {
  const entanglement = touchedFiles / 10 + disturbedRepos / 2 + relatedPulls / 3;
  const span = CONFLICT_CONTEXT_COMMITS_MAX - CONFLICT_CONTEXT_COMMITS_MIN;
  // floor, not round: a barely-entangled conflict should sit at the 3-commit
  // floor rather than being rounded up into extra history nobody needs.
  const depth = CONFLICT_CONTEXT_COMMITS_MIN + Math.floor(Math.min(1, entanglement) * span);
  return Math.max(CONFLICT_CONTEXT_COMMITS_MIN, Math.min(CONFLICT_CONTEXT_COMMITS_MAX, depth));
}

export function buildDossier(args: {
  repo: string;
  prNumber: number;
  headRef: string;
  baseRef: string;
  touchedFiles: readonly string[];
  disturbedBy: readonly string[];
  relatedPulls: readonly number[];
  now: Date;
}): ConflictDossier {
  return {
    repo: args.repo,
    prNumber: args.prNumber,
    headRef: args.headRef,
    baseRef: args.baseRef,
    touchedFiles: args.touchedFiles,
    disturbedBy: args.disturbedBy,
    relatedPulls: args.relatedPulls,
    contextCommits: contextDepth(args.touchedFiles.length, args.disturbedBy.length, args.relatedPulls.length),
    createdAt: args.now.toISOString(),
  };
}

/** The comment left on a conflicted PR. Instructions, not a resolution. */
export function renderDossier(d: ConflictDossier): string {
  const files = d.touchedFiles.slice(0, 40);
  const more = d.touchedFiles.length - files.length;
  return [
    `### Semantic merge required`,
    ``,
    `\`${d.repo}#${d.prNumber}\` (\`${d.headRef}\` → \`${d.baseRef}\`) cannot be fast-forwarded cleanly.`,
    `This job does not resolve conflicts, because resolving one correctly means understanding both`,
    `intents — and picking a side is how meaning gets silently dropped.`,
    ``,
    `**For whoever resolves this (human or agent):**`,
    ``,
    `- Read at least the last **${d.contextCommits} commits** on both \`${d.headRef}\` and \`${d.baseRef}\` before touching a hunk.`,
    `- Merge the two intents conceptually. Do not run \`-X ours\`/\`-X theirs\`, and do not delete a side to make it compile.`,
    `- If both sides changed the same behaviour deliberately, the resolution is usually a third thing, not either input.`,
    ...(d.disturbedBy.length
      ? [
          ``,
          `**Dependency movement that likely caused this:**`,
          ...d.disturbedBy.map((r) => `- \`${r}\``),
        ]
      : []),
    ...(d.relatedPulls.length
      ? [``, `**Open PRs in this repo that touch overlapping files:** ${d.relatedPulls.map((n) => `#${n}`).join(', ')}`]
      : []),
    ``,
    `**Files in this PR** (${d.touchedFiles.length}):`,
    ...files.map((f) => `- \`${f}\``),
    ...(more > 0 ? [`- …and ${more} more`] : []),
    ``,
    `<sub>ores-gh-bots nightly reconcile · ${d.createdAt}</sub>`,
  ].join('\n');
}

/** Open PRs whose changed files overlap this one's — the same-repo interaction from #102. */
export function overlappingPulls(
  self: { number: number; files: readonly string[] },
  others: ReadonlyArray<{ number: number; files: readonly string[] }>,
): number[] {
  const mine = new Set(self.files);
  return others
    .filter((o) => o.number !== self.number && o.files.some((f) => mine.has(f)))
    .map((o) => o.number)
    .sort((a, b) => a - b);
}
