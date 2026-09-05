# ORES GitHub bots

`ores-gh-bots` is the fleet-level control plane for event-driven pull-request review across ORES GitHub organizations. A GitHub App receives pull-request events, reviews the exact current head SHA with both OpenAI and Anthropic, publishes provider-specific check runs, and emits a fail-closed aggregate gate.

## Required checks

Every protected pull-request target requires these exact contexts:

- `ores-review/openai`
- `ores-review/claude`
- `ores-review/gate`

A new commit produces a new SHA and therefore a new set of checks. Results for an earlier SHA cannot satisfy the gate for the current SHA.

## What is implemented

- HMAC-SHA256 verification of GitHub webhook deliveries.
- Event routing for opened, reopened, synchronized, edited, and ready-for-review pull requests.
- Manual authorized `/ores-review` commands and check-run re-requests.
- Distinct optional GitHub App identities for OpenAI, Claude, and the aggregate gate.
- OpenAI Responses API structured output and Anthropic Messages API forced tool output.
- Explicit prompt-injection boundaries: repository content, issue text, commit messages, and diffs are always untrusted data.
- Secret redaction before provider submission and before GitHub publication.
- Bounded file/diff collection with binary-file and truncation accounting.
- A durable SQLite/WAL queue, delivery de-duplication, retry backoff, leases, and review-result persistence.
- A reconciler that scans installed repositories for open pull requests and repairs missing current-SHA checks.
- Optional GitHub Actions dispatch and required-CI aggregation.
- Repository ruleset planning/application in `evaluate` or `active` mode.
- GitHub App manifests, Docker, Compose, Kubernetes, Nix, Just, SOPS, and canary-first rollout assets.

## Fast start

```bash
cp .env.example .env
# Fill App/provider credentials; never commit .env.
npm test
npm start
```

Expose `POST /webhooks/github` over HTTPS and configure the orchestrator GitHub App to send the subscribed events there.

## Monorepo map

- `apps/orchestrator`: webhook server, worker loop, and reconciler.
- `apps/runner`: one-shot review execution for GitHub Actions or incident repair.
- `apps/cli`: App manifest, fleet discovery, and ruleset commands.
- `packages/core`: policy, schemas, redaction, event routing, diff limits, and gate evaluation.
- `packages/github`: App authentication and GitHub REST operations.
- `packages/providers`: OpenAI and Anthropic adapters.
- `packages/queue`: SQLite-backed durable work queue.
- `packages/engine`: review/check/gate orchestration.

## Fleet-hardening contract

`config/hardening-fleet.v1.json` is the canonical public authority for organization hardening bindings. Its co-versioned JSON Schema is `config/hardening-fleet.v1.schema.json`; the policy and schema are validated as an exact, fail-closed pair by `npm run verify:fleet-hardening`.

Consumers must reference the policy by a full 40-character commit SHA and the SHA-256 digest of the policy bytes. A branch, tag, mutable URL, or digest-free reference is not an acceptable binding. The source policy fixes these cross-organization invariants:

- organization-local SQL namespaces with a central migration mirror;
- Diesel code-first and SeaORM database-first migration direction;
- GitOps deployment through the canonical Kubernetes and shared-library repositories;
- a required repository-local hardening binding path;
- immutable source revisions and content digests for every downstream binding.

## Safe rollout

1. Register and install the Apps in `*-test` organizations.
2. Deploy one canary orchestrator replica with persistent storage.
3. Apply rulesets in `evaluate` mode.
4. Open a canary PR and wait for all three checks.
5. Push another commit and verify the old approvals no longer satisfy the PR.
6. Change test rulesets to `active`, observe, then expand to production organizations.

The older nightly reaper remains useful as a recovery path, but it should call this service or enqueue current-SHA reviews rather than act as the primary review trigger.

See `docs/ROLLOUT.md`, `docs/APP_REGISTRATION.md`, and `docs/THREAT_MODEL.md` before activation.
