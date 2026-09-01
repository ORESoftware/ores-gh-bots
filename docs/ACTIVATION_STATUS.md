# Activation status

This document deliberately separates implemented source from live fleet enforcement.

## Current evidence

As of 2026-08-31:

- `ORESoftware/ores-gh-bots` exists with `main` as its default branch.
- The authenticated primary GitHub account reports 155 active organization memberships, all with the `admin` role. This is a point-in-time inventory, not a permanent fleet manifest.
- No ORES review GitHub App installation is visible to the authenticated account.
- The repository's `canary` environment has no configured secrets or variables for the review control plane.
- The scheduled fleet-plan workflow reaches its configuration preflight and fails closed because the required App identities and private keys are absent.
- No dual-review ruleset has been applied by this project.

Therefore the bot is not reviewing or gating fleet pull requests yet.

## Implemented control plane

- Pull-request webhooks enqueue reviews for `opened`, `reopened`, `synchronize`, `edited`, and `ready_for_review` events.
- Review jobs re-fetch the pull request and bind both provider checks to the current head SHA.
- OpenAI and Claude publish through independent GitHub App identities; the aggregate gate uses a third check-writer identity.
- Missing, stale, truncated, malformed, refused, timed-out, or non-approving provider results fail closed.
- A durable reconciler repairs missed deliveries and missing current-SHA checks; the nightly reaper remains a recovery lane rather than the primary trigger.
- GitHub Actions can run as a supplemental audit/recovery lane or an offloaded executor through a separately restricted dispatcher App.
- Rulesets can be planned in `evaluate` mode and activated for every target branch with `--branch-mode all`.
- Canary and production resources use disjoint Kubernetes instance selectors, and CI builds the digest-pinned base image recipe.
- `npm run cli -- canary verify` validates redacted `ores.review-canary.v1` evidence and binds it to a reviewed SHA-256 digest.

## External gates before activation

Complete these in order; do not describe the fleet as protected until the final read-back succeeds.

1. Choose and deploy an immutable container image to the ORES Kubernetes cluster with persistent queue storage.
2. Publish a stable HTTPS hostname and route `POST /webhooks/github` to the service. The checked-in Kubernetes base intentionally has no public Ingress.
3. Register the five Apps from the reviewed manifests: orchestrator, OpenAI reviewer, Claude reviewer, aggregate gate, and central Actions dispatcher.
4. Store App private keys, the webhook secret, and provider keys through the encrypted SOPS/age lifecycle; never place them in GitHub manifests, CLI arguments, repository variables, or plaintext Git files.
5. Install the four public fleet Apps in selected `*-test` organizations. Install the private dispatcher only on `ORESoftware/ores-gh-bots`.
6. Populate and verify the installation inventory, owner allowlist/patterns, check App IDs, required CI contexts, and their App-ID pins.
7. Deploy the canary, confirm `/readyz`, and verify webhook delivery plus all three check runs on a test pull request.
8. Push a second commit to that pull request and capture the first-head success, `synchronize` delivery, unsatisfied second-head gate, fresh second-head success, and ruleset read-back in `ores.review-canary.v1` evidence.
9. Run `npm run cli -- canary verify --evidence PATH`, record its digest in the reviewed activation ticket, then re-run with `--expected-digest` so drift fails closed.
10. Exercise provider failure, timeout, malformed output, prompt injection, webhook replay, manual re-review, required-CI failure, and queue recovery.
11. Apply rulesets to test repositories in `evaluate` mode, inspect results, then activate them with a reviewed `ACTIVATE-*` change ticket.
12. Expand installations and rulesets across the freshly discovered production inventory in reviewed batches, verifying each repository and organization after mutation.

`--branch-mode all` applies the pull-request gate to every target ref matching `refs/heads/**`. It is intentionally disruptive: existing branches can no longer receive direct updates that bypass a pull request and current-SHA checks. Repository creation remains possible because the ruleset sets `do_not_enforce_on_create`.
