# Bound `the1mills` reviewer lane

The bound reviewer lane discovers pull requests that request, mention, or assign a configured GitHub user. It can submit an approval only when GitHub's live state still contains an explicit review request for that user and the exact current head has a successful `ores-review/gate` check from the configured Gate App.

The lane is disabled by default.

## Trust boundaries

GitHub's authenticated API is authoritative. Gmail, Proton Mail, Yahoo Mail, IMAP, and other inbox connectors may produce `ores.gh-bots.reviewer-hints/v1` documents, but those documents only add candidates to the inspection queue. They never authorize a review, an approval, authentication, account recovery, or navigation to an arbitrary link.

Inbox hints are accepted only when all of these conditions hold:

- the sender is `notifications@github.com` or `noreply@github.com`;
- a candidate is represented by an exact `https://github.com/OWNER/REPOSITORY/pull/NUMBER` URL or the equivalent GitHub notification subject;
- the closed schema, field bounds, message count, link count, and 256 KiB file limit pass;
- the configured reviewer matches the document's optional reviewer binding;
- the PR is re-fetched through the authenticated GitHub API before classification.

Raw subjects, snippets, message identifiers, and non-GitHub links are not emitted in plans. Hint identifiers are one-way SHA-256-derived fingerprints. The implementation does not click email links.

When the queue reaches its configured bound, explicit GitHub review requests are selected before assignments, assignments before mentions, and all authenticated GitHub signals before inbox hints. Email volume therefore cannot starve a live review request.

## Approval invariants

An automated approval is rejected unless every invariant below passes immediately before mutation:

1. `GET /user` identifies the token as exactly `REVIEWER_LOGIN` and as a GitHub user, not a bot.
2. The PR is open, non-draft, and not authored by the reviewer.
3. The PR head equals the expected 40-character SHA.
4. The reviewer remains explicitly present in `requested_reviewers`.
5. The reviewer has `write`, `maintain`, or `admin` permission, so the review can count.
6. The exact gate check run has the expected name, Gate App ID, external ID, PR number, head SHA, completed state, and `success` conclusion.
7. No matching current-head approval has already been submitted.
8. A current-head `CHANGES_REQUESTED` review from the bound reviewer is an explicit veto and is never overwritten by automation.
9. Informational `COMMENTED` reviews do not erase or hide an effective approval/change request on the same head.
10. PR state, requested reviewers, collaborator permission, and current-head reviews are fetched again after gate verification immediately before the review POST.
11. The review POST is anchored with `commit_id` to the exact expected head.

Every submitted body discloses that ORES GitHub Bots performed the automation and records the exact head and gate check run. A head movement after the POST is reported as stale and retried only after the new head earns its own gate success.

## Configuration

Keep the credential in the approved encrypted secret channel. Never pass it on the command line or commit it.

```dotenv
REVIEWER_LOGIN=the1mills
REVIEWER_APPROVAL_MODE=off
GITHUB_REVIEWER_TOKEN=
REVIEWER_MAX_ITEMS=100
```

Activation requires changing `REVIEWER_APPROVAL_MODE` to `requested-gate-success`. Startup then fails closed when `GITHUB_REVIEWER_TOKEN` is absent. The token should be a fine-grained user token scoped only to repositories where this lane is intended to operate, with enough pull-request and checks access to read gate evidence and submit a review.

`OWNER_ALLOWLIST` and `OWNER_PATTERNS` remain an independent mutation boundary. A PR can appear in the inspection plan while outside that owner policy, but the reconciler will not approve it.

## Inspecting the queue

The queue command verifies the token identity before searching GitHub:

```bash
GITHUB_REVIEWER_TOKEN='from-secret-manager' \
  npm run cli -- reviewer plan --reviewer the1mills --limit 100
```

An inbox connector can supply bounded hints without changing the authorization rules:

```bash
GITHUB_REVIEWER_TOKEN='from-secret-manager' \
  npm run cli -- reviewer plan \
  --reviewer the1mills \
  --hints ./private/reviewer-hints.json
```

The hints file contract is `config/reviewer-hints.schema.json`. Do not store connector exports or message bodies in the repository.

## Canary evidence

Before activation, preserve evidence for each negative test as well as the success path:

- wrong token identity;
- outside-owner candidate;
- inaccessible or untrusted inbox hint;
- self-authored, draft, or closed PR;
- moved head or removed review request;
- reviewer permission downgraded below `write`;
- missing, failed, stale, or foreign-App gate check;
- existing current-head approval;
- current-head `CHANGES_REQUESTED` review, including one submitted during gate verification;
- informational comment submitted after an approval;
- queue saturation with review requests, assignments, mentions, and inbox hints.

A success-path record must include repository, PR number, exact head SHA, reviewer login, collaborator permission, gate App ID, gate check-run ID, review ID, and timestamps. Never include tokens or raw mailbox content.

## Operations

The deployed orchestrator runs the reviewer reconciler at `RECONCILE_INTERVAL_MS`. A late `pull_request.review_requested` webhook also queues an exact-head gate repair, so an already-reviewed PR does not require another provider invocation merely to publish the user-bound approval.

Monitor:

- `ores_reviewer_reconciliations_total{result="success|partial"}`
- `ores_reviewer_approvals_total`
- structured `bound reviewer reconciliation failed` warnings

Rollback is immediate: set `REVIEWER_APPROVAL_MODE=off`, rotate or revoke the user token, and redeploy. Existing GitHub reviews remain part of the audit trail; do not silently delete them.
