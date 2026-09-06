# Merge and conflict policy

This job is allowed to change other people's branches while nobody is watching.
Everything below exists to make that safe.

## The 55-hour soak

A pull request must have been **open for at least 55 hours** before this job may
merge it. It is implemented as a *gate*, not a weighted signal, and it is checked
twice: once when the PR is scored, and again immediately before the merge call.

The distinction matters. If soak time were a signal, a PR with three approvals
and a wall of green checks could out-score the soak requirement and merge twenty
minutes after it opened. As a gate, no amount of evidence elsewhere buys past it.

`test/reconcile.test.ts` contains a test whose only job is to fail if a future
change lets a young PR merge.

## 99.5% confidence

Among PRs that have cleared every gate, confidence is the product of three
signals, each 1.0 when the evidence is affirmative:

| Signal | 1.0 when | Otherwise |
| --- | --- | --- |
| `reviewed` | at least one approval | 0.9 |
| `checkCoverage` | at least one completed check run | 0.7 |
| `freshBase` | GitHub reports `mergeable_state: clean` | 0.9 |

So in practice, ≥99.5% means: every gate green, **and** somebody approved,
**and** CI actually ran, **and** the base is clean. Any one of those missing
drops the PR below the bar and it is held rather than merged.

## Conflicts are never resolved by this job

The standing instruction across the fleet is to resolve conflicts semantically,
with full context, looking back 3–10 commits for intent — never to hastily pick a
side. A nightly batch job is exactly the wrong place to attempt that, so it
doesn't try.

Instead, a conflicted PR gets:

- the `needs-semantic-merge` label,
- one comment (not one per night — the label is checked first) containing a
  **conflict dossier**: the files involved, the open PRs in the same repo that
  touch overlapping files, the dependency-graph movement that likely caused it,
  and the number of commits of history a resolver should read on each side.

The side-picking strategies — `ours`, `theirs`, `union`, `-X ours`,
`-X theirs`, `-s ours` — are rejected in code by `assertNotSidePicking`, which
throws `SidePickingRejected`. This is enforcement, not documentation: if some
future code path tries to shortcut a conflict, it raises instead of quietly
discarding somebody's work.

## Context depth

The dossier asks for between 3 and 10 commits of history, scaled by how
entangled the conflict looks — file count, how many dependency repos moved, and
how many sibling PRs overlap. A one-file conflict in a quiet repo asks for 3; a
forty-file conflict with dependency movement and overlapping PRs asks for 10.

## What the job will never touch

- Archived repositories.
- Anything in `EXCLUDED_REPOS` — currently `ORESoftware/dd` and
  `ORESoftware/dd-next-1`, excluded from all automated agent work by standing
  request.
- Draft PRs, and anything labelled `do-not-merge`, `hold`, `wip` or `blocked`.

## Dry run is the default

`src/cli.ts` runs in dry-run mode unless `--apply` is passed. The scheduled
workflow passes `--apply`; manual `workflow_dispatch` runs default to dry run.
