# GitHub Actions workflow security policy

This policy is binding for every workflow in `ORESoftware/ores-gh-bots`, including review dispatch, fleet discovery, ruleset rollout, reconciliation, and merge-reaper jobs.

## Immutable workflow dependencies

Every external `uses:` reference must be pinned to a full 40-character commit SHA. Version tags may remain only as comments for readability. Local reusable workflows and `docker://` references are outside that exact syntax rule, but container images must use immutable digests wherever credentials or write authority are present.

## Event data and shell source

GitHub event fields and `workflow_dispatch` inputs are data, not source code. A workflow must never splice pull-request titles, bodies, branch names, issue text, comment bodies, or dispatch inputs directly into a `run:` command or block.

Map needed values through a step-level `env:` entry, a bounded JSON file, or a typed application interface. The receiving program must validate lengths, formats, allowlists, and exact repository or SHA bindings before performing an effect.

## Fleet write identity

Cross-repository checks, comments, rulesets, branch updates, and merges require a dedicated least-privilege GitHub App identity. Personal access tokens and broad fleet tokens are prohibited in workflows. The default `GITHUB_TOKEN` may be used only for the current repository within explicitly declared minimal permissions.

Reviewing, gating, Actions dispatch, ruleset administration, and merge-reaper effects remain separate App identities. A provider approval cannot publish its own aggregate gate, and the reaper cannot bypass the exact-current-head `ores-review/gate` result.

## Fail-closed merge boundary

A merge-capable workflow must re-read the pull request immediately before the merge effect and bind the operation to the expected head SHA. It must reject stale heads, draft state, conflicts, unresolved change requests, missing independent CI, missing or foreign gate provenance, policy cycles, and unreviewed dependencies.

Scheduled recovery is a backstop. It does not replace event-driven OpenAI and Claude review, and it never converts missing evidence into success.

## Automated guard

`test/workflow-security-policy.test.mjs` scans every committed workflow and blocks three recurring regression classes:

1. mutable Action tags;
2. attacker-controlled GitHub expressions embedded in shell source; and
3. PAT-based fleet authority.

A policy exception requires a narrowly scoped, expiring security review with tests proving the same trust boundary by another mechanism.
