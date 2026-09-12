import {
  EXCLUDED_REPOS,
  MERGE_CONFIDENCE_THRESHOLD,
  MIN_OPEN_HOURS,
  type ReconcileOptions,
} from './config.ts';
import { GitHubClient, GitHubError, type PullRequest, type Repo } from './github.ts';
import { buildGraph, disturbanceSet, parseGitmodules, parseZpkgToml, repoFromGitUrl, resolveZedDep, type DepEdge, type DepGraph } from './depgraph.ts';
import { evaluate, type Readiness } from './readiness.ts';
import { buildDossier, overlappingPulls, renderDossier } from './conflicts.ts';
import { log } from './log.ts';

export type Action = 'merged' | 'updated' | 'escalated' | 'held' | 'skipped' | 'failed';

export interface PullOutcome {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly action: Action;
  readonly reason: string;
  readonly confidence: number;
  readonly hoursOpen: number;
  readonly disturbedBy: readonly string[];
}

export interface ReconcileReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly dryRun: boolean;
  readonly reposScanned: number;
  readonly pullsScanned: number;
  readonly outcomes: readonly PullOutcome[];
  readonly apiCalls: number;
}

const CONFLICT_LABEL = 'needs-semantic-merge';

/**
 * Reads `.zpkg.toml`, `.zpkg.lock` and `.gitmodules` from every repo's default
 * branch and assembles the fleet dependency graph. Repos without any of the
 * three simply contribute no edges.
 */
export async function collectDepGraph(
  gh: GitHubClient,
  repos: ReadonlyArray<{ owner: string; repo: Repo }>,
): Promise<DepGraph> {
  const known = new Set(repos.map((r) => `${r.owner}/${r.repo.name}`));
  const edges: DepEdge[] = [];

  for (const { owner, repo } of repos) {
    const from = `${owner}/${repo.name}`;
    const [manifest, lock, submodules] = await Promise.all([
      gh.getFile(owner, repo.name, '.zpkg.toml', repo.default_branch).catch(() => null),
      gh.getFile(owner, repo.name, '.zpkg.lock', repo.default_branch).catch(() => null),
      gh.getFile(owner, repo.name, '.gitmodules', repo.default_branch).catch(() => null),
    ]);

    for (const text of [manifest, lock]) {
      if (!text) continue;
      const parsed = parseZpkgToml(text);
      for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies', 'package']) {
        const table = parsed[section];
        if (!table || section === 'package') continue;
        for (const [name, spec] of Object.entries(table)) {
          const to = resolveZedDep(name, spec, known);
          if (to) edges.push({ from, to, kind: 'zed', spec });
        }
      }
    }

    if (submodules) {
      for (const sm of parseGitmodules(submodules)) {
        const to = repoFromGitUrl(sm.url);
        if (to && known.has(to)) edges.push({ from, to, kind: 'submodule', spec: sm.path });
      }
    }
  }

  log.info('dependency graph built', { edges: edges.length, repos: repos.length });
  return buildGraph(edges);
}

/**
 * Repos in this PR's disturbance set that were pushed after the PR last moved.
 * This is the signal that a PR needs refreshing even though its own base is
 * unchanged — a dependency shipped underneath it.
 */
export function disturbedSince(
  graph: DepGraph,
  fullName: string,
  prUpdatedAt: string,
  pushedAt: ReadonlyMap<string, string>,
): string[] {
  const since = new Date(prUpdatedAt).getTime();
  return disturbanceSet(graph, fullName).filter((neighbour) => {
    const pushed = pushedAt.get(neighbour);
    return pushed !== undefined && new Date(pushed).getTime() > since;
  });
}

export async function reconcilePull(
  gh: GitHubClient,
  owner: string,
  repoName: string,
  listed: PullRequest,
  ctx: {
    graph: DepGraph;
    pushedAt: ReadonlyMap<string, string>;
    siblings: ReadonlyArray<{ number: number; files: readonly string[] }>;
    now: Date;
    dryRun: boolean;
  },
): Promise<PullOutcome> {
  const full = `${owner}/${repoName}`;
  // The list endpoint omits `mergeable`; re-fetch so the conflict gate has real data.
  const pr = await gh.getPull(owner, repoName, listed.number);
  const disturbedBy = disturbedSince(ctx.graph, full, pr.updated_at, ctx.pushedAt);

  const [reviews, checks] = await Promise.all([
    gh.listReviews(owner, repoName, pr.number),
    gh.listCheckRuns(owner, repoName, pr.head.sha),
  ]);

  const readiness: Readiness = evaluate({ pr, reviews, checks, now: ctx.now, disturbedBy });
  const ageHours = (ctx.now.getTime() - new Date(pr.created_at).getTime()) / 3_600_000;

  const base = {
    repo: full,
    number: pr.number,
    title: pr.title,
    confidence: readiness.confidence,
    hoursOpen: Number(ageHours.toFixed(2)),
    disturbedBy,
  };

  try {
    switch (readiness.recommendation) {
      case 'merge': {
        // Belt and braces: the soak gate is re-asserted at the point of action,
        // not just at the point of scoring.
        if (ageHours < MIN_OPEN_HOURS) {
          return { ...base, action: 'held', reason: `soak gate: ${ageHours.toFixed(1)}h < ${MIN_OPEN_HOURS}h` };
        }
        if (readiness.confidence < MERGE_CONFIDENCE_THRESHOLD) {
          return { ...base, action: 'held', reason: 'confidence below threshold at action time' };
        }
        if (ctx.dryRun) return { ...base, action: 'skipped', reason: `would merge — ${readiness.reason}` };
        await gh.merge(owner, repoName, pr.number, pr.head.sha);
        return { ...base, action: 'merged', reason: readiness.reason };
      }

      case 'update': {
        if (ctx.dryRun) return { ...base, action: 'skipped', reason: `would update — ${readiness.reason}` };
        const ok = await gh.updateBranch(owner, repoName, pr.number, pr.head.sha);
        if (ok) return { ...base, action: 'updated', reason: readiness.reason };
        // update-branch refused: that is a conflict, so it becomes an escalation.
        return escalate();
      }

      case 'escalate':
        return escalate();

      default:
        return { ...base, action: 'held', reason: readiness.reason };
    }
  } catch (err) {
    const msg = err instanceof GitHubError ? err.message : String(err);
    log.error('pull reconcile failed', { repo: full, pr: pr.number, err: msg });
    return { ...base, action: 'failed', reason: msg };
  }

  async function escalate(): Promise<PullOutcome> {
    const files = (await gh.listPullFiles(owner, repoName, pr.number)).map((f) => f.filename);
    const related = overlappingPulls({ number: pr.number, files }, ctx.siblings);
    const dossier = buildDossier({
      repo: full,
      prNumber: pr.number,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      touchedFiles: files,
      disturbedBy,
      relatedPulls: related,
      now: ctx.now,
    });
    if (!ctx.dryRun) {
      const alreadyFlagged = pr.labels.some((l) => l.name === CONFLICT_LABEL);
      if (!alreadyFlagged) {
        await gh.addLabels(owner, repoName, pr.number, [CONFLICT_LABEL]);
        await gh.comment(owner, repoName, pr.number, renderDossier(dossier));
      }
    }
    return {
      ...base,
      action: 'escalated',
      reason: `conflict — dossier prepared, ${dossier.contextCommits} commits of context requested`,
    };
  }
}

export async function reconcile(gh: GitHubClient, options: ReconcileOptions, now: Date = new Date()): Promise<ReconcileReport> {
  const startedAt = now.toISOString();
  const outcomes: PullOutcome[] = [];
  const allRepos: Array<{ owner: string; repo: Repo }> = [];
  const pushedAt = new Map<string, string>();

  for (const org of options.orgs) {
    let repos: Repo[];
    try {
      repos = await gh.listOrgRepos(org);
    } catch (err) {
      log.warn('org unreadable, skipping', { org, err: String(err) });
      continue;
    }
    const usable = repos
      .filter((r) => !r.archived)
      .filter((r) => !EXCLUDED_REPOS.includes(r.full_name))
      .filter((r) => !options.repoFilter || r.name.includes(options.repoFilter))
      .slice(0, options.maxReposPerOrg ?? undefined);
    for (const r of usable) {
      allRepos.push({ owner: org, repo: r });
      const pushed = (r as Repo & { pushed_at?: string }).pushed_at;
      if (pushed) pushedAt.set(r.full_name, pushed);
    }
  }

  const graph = await collectDepGraph(gh, allRepos);

  let pullsScanned = 0;
  for (const { owner, repo } of allRepos) {
    let pulls: PullRequest[];
    try {
      pulls = await gh.listOpenPulls(owner, repo.name);
    } catch (err) {
      log.warn('pulls unreadable, skipping', { repo: repo.full_name, err: String(err) });
      continue;
    }
    if (pulls.length === 0) continue;

    // File lists for every open PR in the repo, so same-repo interaction is visible.
    const siblings = await Promise.all(
      pulls.map(async (p) => ({
        number: p.number,
        files: (await gh.listPullFiles(owner, repo.name, p.number).catch(() => [])).map((f) => f.filename),
      })),
    );

    for (const p of pulls) {
      pullsScanned++;
      const outcome = await reconcilePull(gh, owner, repo.name, p, {
        graph,
        pushedAt,
        siblings,
        now,
        dryRun: options.dryRun,
      });
      outcomes.push(outcome);
      log.info('pull reconciled', outcome as unknown as Record<string, unknown>);
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    reposScanned: allRepos.length,
    pullsScanned,
    outcomes,
    apiCalls: gh.callCount,
  };
}

export function summarise(report: ReconcileReport): string {
  const by = (a: Action) => report.outcomes.filter((o) => o.action === a).length;
  return [
    `repos ${report.reposScanned} · pulls ${report.pullsScanned} · api ${report.apiCalls}`,
    `merged ${by('merged')} · updated ${by('updated')} · escalated ${by('escalated')} · held ${by('held')} · skipped ${by('skipped')} · failed ${by('failed')}`,
  ].join('\n');
}
