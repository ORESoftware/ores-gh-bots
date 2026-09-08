# Review automation audit — 2026-09-08

Audit window: 2026-08-14 through 2026-09-08.

This document consolidates the unfinished GitHub-review, reviewer-identity, inbox-discovery, CI-capacity, and merge-governance threads found during the audit. It intentionally separates code that can be reviewed and merged now from activation work that requires credentials, permissions, infrastructure, or an independent human decision.

## Governing rules

- Follow `ORESoftware/my-ai/AGENTS.md` and repository-local `AGENTS.md` files.
- Resolve conflicts semantically using both sides and relevant history.
- Never force-push, rebase, reset, stash over another worker, self-approve, weaken required checks, or use an administrator bypass to make a PR mergeable.
- Treat the exact current PR head as the unit of review, CI evidence, approval, and merge.
- A failed, pending, missing, stale, foreign-App, or unverifiable check is a blocker, not an invitation to infer success.
- GitHub's authenticated API is authoritative for review requests. Mailboxes are discovery-only.

## Completed in the DEN-3570 code slice

- Bound the reviewer token to the exact configured human login through `GET /user`.
- Added live discovery for explicit review requests, assignments, and mentions.
- Added a closed, bounded inbox-hint contract for Gmail, Proton Mail, Yahoo Mail, or IMAP adapters.
- Sanitized hints down to PR coordinates, source classes, and one-way fingerprints; no link clicking or mailbox-content persistence.
- Required an open, non-draft, non-self-authored PR and a still-live explicit review request.
- Required `write`, `maintain`, or `admin` collaborator permission so the review can count.
- Bound approval to the exact head and an exact successful aggregate Gate-App check.
- Re-read PR state, requested reviewer, permission, and effective current-head review state immediately before mutation.
- Preserved human intent: `CHANGES_REQUESTED` is a veto; later informational comments cannot hide an approval or change request.
- Made approval idempotent for an existing current-head approval.
- Prioritized explicit review requests over assignments, mentions, and inbox hints when the queue is full.
- Added late `pull_request.review_requested` handling, bounded live-fetch concurrency, metrics, CLI planning, tests, and rollback documentation.
- Kept the reviewer lane disabled by default.

## Unfinished activation dependencies

### Independent GitHub identities

The orchestrator, OpenAI reviewer, Claude reviewer, aggregate gate, and Actions dispatcher must use distinct GitHub App identities where policy requires independence. App IDs and check-run provenance must be verified in a test repository before ruleset activation.

### `the1mills` eligibility and credential

`the1mills` must be a requestable collaborator on each intended repository with the minimum permission that makes the review count. Do not grant broad organization administration merely to satisfy automation. Provision a fine-grained token that authenticates exactly as `the1mills`, scope it to intended repositories, and deliver it only through the approved SOPS+age/secret-manager path.

### Mailbox adapters

Implement authenticated connector adapters that emit `ores.gh-bots.reviewer-hints/v1` and nothing more. Gmail can be enabled first. Proton Mail and Yahoo/IMAP remain separate adapters and must not be approximated by scraping or arbitrary link navigation. Adapter tests must cover spoofed senders, lookalike domains, oversized exports, malformed subjects, duplicate messages, inaccessible repositories, and reviewer-binding mismatches.

### Deployment and canary

Deploy with `REVIEWER_APPROVAL_MODE=off`, run no-write plans, and validate negative cases before enabling a single test repository. Preserve exact SHA, App ID, check-run ID, reviewer identity, review ID, timestamps, and rollback evidence. Expand scope only after the canary report receives independent review.

### GitHub Actions capacity

Recent inbox threads included repeated organization-level Actions minute/storage exhaustion warnings. Missing capacity can suppress or delay required checks, so the gate must remain fail-closed. Track per-organization minutes, storage, queued duration, skipped jobs, and artifact retention. Prefer approved self-hosted/offload capacity through `gha-indie-worker` only after its exact-head PR is independently approved and its worker identity, isolation, and cleanup behavior are verified.

### Fleet rulesets

Ruleset rollout must begin in evaluate mode on test organizations, cover every protected branch intended by policy, pin required check names to expected App IDs where GitHub supports it, and include rollback. Do not activate a fleet-wide rule while parent PRs, App installations, webhook delivery, or worker capacity are unresolved.

## PR dependency and merge protocol

The active work is stacked. Parent changes must land before child branches are retargeted or merged. For every related PR:

1. Fetch the exact current head and compare it with the reviewed head.
2. Read repository-local instructions and all unresolved review threads.
3. Require all configured checks to be completed successfully.
4. Require an independent current-head approval when policy calls for one.
5. Resolve conflicts semantically; never discard either side wholesale.
6. Merge without administrator bypass and record the resulting commit.
7. Re-run the child PR against its new base and repeat the full gate.

Known related queues include the dual-review activation series in `ORESoftware/ores-gh-bots`, the DEN-3570 bound-reviewer slice, and the `gha-indie-worker/gha-indie-worker.rs` offload hardening PR. Live GitHub state, not this dated audit, determines whether any particular PR is currently mergeable.

## Negative-test matrix required before activation

- token resolves to a different user or to a bot;
- owner/repository falls outside policy;
- PR is closed, draft, self-authored, or its head moves;
- review request is removed or collaborator permission is downgraded;
- current-head approval already exists;
- current-head change request exists or arrives during gate verification;
- informational comment follows an approval/change request;
- gate check is absent, pending, failed, stale, has a foreign App ID, or has a mismatched external ID;
- queue is saturated by mentions or mailbox hints;
- inbox sender/domain is spoofed or the export exceeds bounds;
- API rate limits, transient 5xx responses, Actions quota exhaustion, and process restart occur;
- rollback disables the lane and token rotation prevents any further mutation.

## Completion criteria

The thread is complete only when code PRs are green and independently approved, credentials and collaborator scope are reviewed, test-org canaries and rollback drills are recorded, Actions capacity is sufficient, mailbox adapters pass adversarial tests, rulesets are activated in controlled stages, and production metrics show no stale-head or unauthorized review mutations.
