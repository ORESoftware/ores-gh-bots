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
npm test          # 67 tests, no install required
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

## Second bot: fleet git hygiene

`src/hygiene-cli.ts` ensures every repo under a checkout root ignores
`tmp/temp/` and `tmp/worktrees/` — the scratch and worktree paths that agent
runs write into, whose untracked entries otherwise clutter every `git status`
and invite being swept into unrelated commits (chat #78, DEN-3956).

```bash
node --experimental-strip-types src/hygiene-cli.ts --root ~/codes            # dry run
node --experimental-strip-types src/hygiene-cli.ts --root ~/codes --commit   # apply + commit
```

Three properties make it safe to run repeatedly across a thousand repos:

- **The patterns live in a delimited managed block.** Appending loose lines is
  what makes this kind of script un-runnable twice — the second pass either
  duplicates them or has to guess which trailing lines it wrote. A marked block
  can be located, compared, and rewritten in place.
- **It stages only `.gitignore`.** These repos routinely carry unrelated work in
  progress. The commit uses `--only -- .gitignore` and verifies the staged set
  is exactly that one path before committing; anything else aborts the repo.
- **It respects rules the repo already has.** A repo ignoring `tmp/` is left
  completely untouched, and a repo ignoring only `tmp/worktrees/` gets just the
  missing pattern — no redundant block.

Skipped by design: `dd` and `dd-next-1` (excluded from automated agent work by
standing request), `_to_delete`, `node_modules`, `target`, `vendor`, `dist`,
`build`, any repo nested inside another repo, and git worktrees, which share
their parent checkout's `.gitignore`.

### A note on this filesystem

The Cowork mount forbids `unlink`, so git leaves its `.lock` files behind and
the *next* git command in that repo fails with "unable to create … File
exists". `sweepGitLocks` runs after every git invocation and parks those files
in `--sink` when it cannot delete them. That is an environment workaround, not
a design choice — on a normal filesystem the `rmSync` path succeeds and the
sink is never touched.

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
| `src/cli.ts` | Nightly reconciler entry point |
| `src/hygiene/` | Fleet .gitignore hygiene: repo discovery, idempotent patching |
| `src/hygiene-cli.ts` | Hygiene entry point |

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
