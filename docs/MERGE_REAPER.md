# Dependency-aware nightly merge reaper

The nightly reaper is a recovery and backlog-drain lane. It does not replace
pull-request webhooks, provider reviews, the aggregate ORES gate, repository
rulesets, or a merge queue.

## Schedule and effect budget

`.github/workflows/nightly-merge-reaper.yml` runs at 01:00
`America/Chicago`. Two UTC schedules cover daylight and standard time; a local
timezone gate admits only the matching run. Manual dispatch defaults to a
no-write plan.

One run can merge at most three pull requests, sequentially. The policy parser
rejects a larger value rather than clamping it silently.

## Separate merge identity

Merge effects use the dedicated `reaper` GitHub App. The webhook orchestrator,
provider reviewers, aggregate gate, Actions dispatcher, and reaper remain
separate identities. The reaper has only:

- checks: read;
- commit statuses: read;
- metadata: read;
- pull requests: write;
- contents: write.

It subscribes to no webhook events. Workflow `GITHUB_TOKEN` receives only
`contents: read` and is never used for a merge.

## Fail-closed eligibility

A pull request is eligible only when all of these are true at the same current
head SHA:

1. It is open, non-draft, at least 55 hours old, and targets an allowed base.
2. GitHub reports it as mergeable with `mergeable_state=clean`.
3. It carries an explicit opt-in label such as `ores-automerge` and no deny
   label such as `hold`, `blocked`, `security-review`, or `do-not-merge`.
4. The exact external ID for `ores-review/gate` is successful and belongs to
   the configured aggregate-gate App ID.
5. Every independent current-SHA CI/check/status context is successful. Empty,
   pending, skipped, neutral, cancelled, timed-out, stale, or failed sets block.
6. No reviewer's latest state is `CHANGES_REQUESTED`.
7. GitHub reports zero unresolved review threads.
8. Every explicit `Depends-On`, `Requires`, `Merge-After`, or `Stacked-On`
   pull request is already merged or is an eligible predecessor in the same
   ordered run.
9. The reviewed repository dependency graph is acyclic.

Before every write, the reaper re-fetches the pull request, gate, CI states,
reviews, and review threads. The merge request includes the expected head SHA;
GitHub must reject a moved head. Native auto-merge and disallowed stacked base
branches are left untouched.

## Dependency order

`config/merge-reaper.example.json` defines reviewed repository-level edges for
interfaces, libraries, clients, and monorepos. Pull-request bodies may add exact
PR edges using forms such as:

```text
Depends-On: shared-auth/shared-auth-lib#81
Stacked-On: #79
```

Dependency candidates are topologically sorted before age ordering. A cycle,
unavailable dependency, open unmerged dependency, or blocked predecessor keeps
the dependent pull request out of the effect set.

## Activation

Source completeness is not activation. Before scheduled apply mode can merge:

1. Register the dedicated reaper App from
   `github-apps/merge-reaper.manifest.json`.
2. Install it in selected test organizations, then populate the reviewed
   installation inventory.
3. Store its ID/private key through the SOPS/Age secret lifecycle.
4. Configure `OWNER_ALLOWLIST` or `OWNER_PATTERNS` and the aggregate
   `GATE_APP_ID`.
5. Run a manual `plan`, inspect the artifact, then exercise `apply` on a
   disposable test pull request carrying the explicit opt-in label.
6. Prove stale SHA, failed CI, missing gate, requested changes, unresolved
   threads, dependency cycles, and deny labels all prevent a merge.

Scheduled apply mode fails before discovery when credentials or owner policy are
missing. It never falls back to a PAT or to the workflow token.
