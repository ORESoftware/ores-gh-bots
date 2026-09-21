# Dependency-aware merge reaper

The merge reaper is a bounded recovery/automation lane for pull requests that have already satisfied the normal review boundary. It does not create approvals, manufacture CI evidence, bypass the aggregate gate, or make an unreviewed branch mergeable.

## Identity boundary

The reaper uses a dedicated fleet-scoped GitHub App described by `github-apps/merge-reaper.manifest.json`. Its identity must be distinct from the Gate App. The Gate App produces `ores-review/gate`; the reaper may only consume that evidence and perform the final exact-head merge effect.

Required encrypted secrets are `MERGE_REAPER_APP_ID` and `MERGE_REAPER_APP_PRIVATE_KEY`. Do not substitute a personal access token or reuse the Gate App private key.

The checked-in manifest intentionally has no webhook events. The reaper runs only from the central scheduled/manual workflow and refreshes installation tokens through `AppAuth`; it does not keep one pre-minted installation token for the lifetime of a fleet run.

## Eligibility

`packages/engine/src/merge-reaper.mjs` is the policy authority. Before selection, a candidate must satisfy all configured constraints, including:

- open, non-draft, cleanly mergeable state;
- minimum age and allowed base branch;
- explicit automerge opt-in and no deny label;
- exact current-head `ores-review/gate` success from the configured Gate App, with the deterministic external ID;
- at least one independent CI context and no non-successful effective CI context;
- no current `CHANGES_REQUESTED` review and, when configured, a human approval;
- no unresolved review threads;
- all declared/stacked dependencies ready.

The policy hard-caps one run at three merge effects. Immediately before each effect, the executable re-fetches the pull request and all gate/CI/review/thread evidence, recomputes dependency state, and then calls `mergePullRequestExact`, which binds GitHub's merge request to the freshly observed head SHA.

## Commands

The canonical flags2env contract exposes:

```text
node apps/reaper/src/main.mjs reaper plan
node apps/reaper/src/main.mjs reaper apply --confirm MERGE-<ticket>
```

`plan` never writes to GitHub. `apply` requires a bounded `MERGE-*` acknowledgement in addition to the policy gates. The scheduled workflow supplies its own fixed acknowledgement only after its local-time admission gate and repository verification succeed.

## Reports

The executable writes the detailed report as mode `0600`. That report can include private repository and pull-request metadata and is never uploaded by the workflow. The workflow derives a content-free receipt containing only mode, policy parameters, aggregate counts, and a `privateMetadataRedacted` marker, deletes the private report, and uploads only the redacted receipt.

## Activation

The code and workflow being present does not mean the reaper is live. Activation still requires registering the dedicated App, installing it only on intended accounts, provisioning the two secrets through the approved encrypted secret path, validating installation inventory, and first exercising manual `plan` mode. Keep scheduled apply inert until those prerequisites and the normal review-control-plane canary evidence are complete.

This runtime is a semantic salvage of the useful merge-reaper capability that was stranded in stale activation PR #15. It deliberately uses current `main` engine/GitHub helpers instead of merging that historical snapshot.
