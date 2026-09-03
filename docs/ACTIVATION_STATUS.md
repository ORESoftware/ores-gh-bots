# Activation status

This document deliberately separates implemented source from live fleet enforcement.

## Current evidence

As of 2026-09-03:

- `ORESoftware/ores-gh-bots` exists with `main` as its default branch.
- The authenticated primary GitHub account reported 155 active organization memberships, all with the `admin` role, during the 2026-08-31 inventory. This is a point-in-time observation, not a permanent fleet manifest.
- No ORES review GitHub App installation was visible to the authenticated account during that inventory.
- The repository's `canary` environment had no configured secrets or variables for the review control plane.
- The scheduled fleet-plan workflow reached its configuration preflight and failed closed because the required App identities and private keys were absent.
- No dual-review ruleset has been applied by this project.

The live two-head canary in pull request #18 on 2026-09-02 confirmed the activation gap rather than assuming source completeness meant deployment:

- Ordinary GitHub Actions `validate` checks passed independently on both the opened head and the later `pull_request.synchronize` head.
- No `ores-review/openai`, `ores-review/claude`, or `ores-review/gate` check was created for either exact SHA.
- No GitHub pull-request review was submitted by an ORES identity.
- An authorized `/ores-review` comment produced no bot response and no new check, proving no deployed webhook consumer handled the command.
- Ruleset read-back showed only the bootstrap rule on `refs/heads/main`, requiring one human approval and an unpinned `validate` status. It did not require either provider identity or the aggregate gate, and it did not protect the canary's feature target branch.

Therefore the implementation is not yet reviewing or gating fleet pull requests. This is a failed-closed deployment result: do not merge around it, substitute ordinary CI for either provider, or claim fleet protection before the activation sequence below is complete.

## Implemented control plane

- Pull-request webhooks enqueue reviews for `opened`, `reopened`, `synchronize`, `edited`, and `ready_for_review` events.
- Review jobs re-fetch the pull request and bind both provider checks to the current head SHA.
- OpenAI and Claude publish through independent GitHub App identities; the aggregate gate uses a third check-writer identity.
- Missing, stale, truncated, malformed, refused, timed-out, or non-approving provider results fail closed.
- A durable reconciler repairs missed deliveries and missing current-SHA checks; the nightly reaper remains a recovery lane rather than the primary trigger.
- GitHub Actions can run as a supplemental audit/recovery lane or an offloaded executor through a separately restricted dispatcher App.
- Rulesets can be planned in `evaluate` mode and activated for every target branch with `--branch-mode all`.
- Canary and production resources use disjoint Kubernetes instance selectors, and CI builds the digest-pinned base image recipe.

## External gates before activation

Complete these in order; do not describe the fleet as protected until the final read-back succeeds.

1. Choose and deploy an immutable container image to the ORES Kubernetes cluster with persistent queue storage.
2. Publish a stable HTTPS hostname and route `POST /webhooks/github` to the service. The checked-in Kubernetes base intentionally has no public Ingress.
3. Register the five Apps from the reviewed manifests: orchestrator, OpenAI reviewer, Claude reviewer, aggregate gate, and central Actions dispatcher.
4. Store App private keys, the webhook secret, and provider keys through the encrypted SOPS/age lifecycle; never place them in GitHub manifests, CLI arguments, repository variables, or plaintext Git files.
5. Install the four public fleet Apps in selected `*-test` organizations. Install the private dispatcher only on `ORESoftware/ores-gh-bots`.
6. Populate and verify the installation inventory, owner allowlist/patterns, check App IDs, required CI contexts, and their App-ID pins.
7. Deploy the canary, confirm `/readyz`, and verify webhook delivery plus all three check runs on a test pull request.
8. Push a second commit to that pull request and prove the first SHA's successful checks cannot satisfy the new SHA.
9. Exercise provider failure, timeout, malformed output, prompt injection, webhook replay, manual re-review, required-CI failure, and queue recovery.
10. Apply rulesets to test repositories in `evaluate` mode, inspect results, then activate them with a reviewed `ACTIVATE-*` change ticket.
11. Expand installations and rulesets across the freshly discovered production inventory in reviewed batches, verifying each repository and organization after mutation.

`--branch-mode all` applies the pull-request gate to every target ref matching `refs/heads/**`. It is intentionally disruptive: existing branches can no longer receive direct updates that bypass a pull request and current-SHA checks. Repository creation remains possible because the ruleset sets `do_not_enforce_on_create`.
