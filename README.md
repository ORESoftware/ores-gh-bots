# ores-gh-bots

GitHub automation bots for the ORESoftware fleet.

The first bot is the **nightly cross-org PR reconciler**: it walks every open
pull request in every org, refreshes the ones that have drifted (including
because something moved underneath them in the zed dependency graph), merges
only what is genuinely ready, and hands conflicts to a semantic resolver instead
of guessing.

Tracked as **DEN-3946**. Originating request: `alex-alex-me` chat #102.

## Why it isn't just a cron that calls `update-branch`

A PR can be stale for three different reasons, and only one of them is visible
from the PR itself:

1. **Its base moved.** GitHub tells you this (`mergeable_state: behind`).
2. **A sibling PR in the same repo landed and touched the same files.** Visible
   only by diffing the two PRs' file lists.
3. **A dependency shipped.** A zed package or git submodule the repo consumes
   released underneath it. Nothing on the PR reflects this at all.

This job reads `.zpkg.toml`, `.zpkg.lock` and `.gitmodules` across the fleet,
builds the real dependency graph, and treats case 3 as first-class: a PR whose
dependency-graph neighbours were pushed after the PR last moved is **disturbed**,
and gets refreshed rather than merged on stale evidence.

## Quick start

```bash
# dry run over one org — changes nothing
GITHUB_TOKEN=… node --experimental-strip-types src/cli.ts \
  --org zed-pkg --ignore-schedule --max-repos 5

# the real thing
GITHUB_TOKEN=… node --experimental-strip-types src/cli.ts --apply
```

Dry run is the default. Pass `--apply` to actually merge, update and comment.

```bash
npm test          # 46 tests, no install required
npm run typecheck # needs `npm i` for typescript
```

## No dependencies

Runtime and tests use only Node 22 built-ins — `fetch`, `node:test`,
`--experimental-strip-types`. There is no install step in the nightly workflow,
so a registry outage can never take the fleet's PR hygiene down with it. The
`devDependencies` exist purely so `npm run typecheck` works locally.

## The rules it enforces

- **55 hours minimum** before any auto-merge. A gate, not a score — see
  [docs/policy.md](docs/policy.md).
- **≥99.5% confidence**, which in practice means every gate green plus an
  approval, real CI evidence, and a clean base.
- **Conflicts are never auto-resolved.** Side-picking merge strategies throw.
  Conflicted PRs get a labelled dossier telling the resolver how much history to
  read and what dependency movement probably caused it.

## Layout

| Path | What it does |
| --- | --- |
| `src/config.ts` | Fleet org list, thresholds, exclusions |
| `src/schedule.ts` | 1am America/Chicago gate, DST-correct in both directions |
| `src/github.ts` | Dependency-free REST client with pagination and backoff |
| `src/depgraph.ts` | zed + submodule graph, disturbance sets |
| `src/readiness.ts` | Gates and confidence signals |
| `src/conflicts.ts` | Side-picking rejection, conflict dossiers |
| `src/reconcile.ts` | The pass itself |
| `src/cli.ts` | Entry point |

## Scheduling note

GitHub Actions cron is UTC-only and America/Chicago shifts twice a year, so the
workflow schedules **both** 06:00 and 07:00 UTC and the job decides which one is
actually 1am in Chicago. On the autumn fall-back date 1am occurs *twice*, and
`isScheduledHour` lets only the first through — otherwise the fleet would be
reconciled twice that night. There is a test for this.

## Setup

The workflow needs a `FLEET_PR_TOKEN` secret: a token that can read and write
pull requests across every org in `FLEET_ORGS`. The default `GITHUB_TOKEN` only
reaches the repo the workflow lives in, which is not enough.

## Not yet built

The evented per-PR review bot (ChatGPT + Claude both reviewing before merge) is
tracked separately as DEN-3570 / DEN-3773. This repo is where it lands; the
nightly pass is the safety net underneath it, not a replacement for it.
