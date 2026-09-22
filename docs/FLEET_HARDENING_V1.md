# ORES fleet hardening v1

Fleet hardening is a **proposal generator**, not a fleet-wide direct writer. One invocation targets exactly one configured organization, binds the proposal set to exact default-branch heads, and opens ordinary pull requests from deterministic proposal branches. Repository CI, CODEOWNERS, human/agent review, and merge policy remain authoritative.

The deprecated direct-write path is fail-closed. `applyOrganizationHardening(..., { dryRun: false })` rejects before any mutation, and the shared file helper rejects non-dry-run writes without an explicit branch.

## Trust boundaries

Fleet-hardening writes use the dedicated `FLEET_HARDENING_APP_ID` identity. Its App has only `contents:write`, `pull_requests:write`, and `metadata:read`. It has no checks permission, no repository-administration permission, and no merge authority. Keep it distinct from the review Gate App and Merge Reaper App.

Plans bind:

- the current fleet configuration digest;
- a digest of the reviewed fleet-hardening implementation;
- the exact source revision used to produce the plan;
- exactly one organization and its declared `test` or `production` environment;
- every selected repository/default branch and its exact head SHA;
- every proposed file path, canonical content, content SHA-256, and previous blob SHA when present.

Apply revalidates the complete target set before the first write. Any branch-head drift rejects the entire plan. A deterministic `ores/fleet-hardening/<plan-digest-prefix>` branch is then created per affected repository and an ordinary PR is opened. The tool never merges those PRs.

## Repository scope

The configured `repository_scope` is enforced during planning. Archived, disabled, and fork repositories are excluded by default. `include` glob patterns and `exclude_name_patterns` are both honored. A plan may contain at most 1,000 file operations, and the repository scan has a separately bounded maximum.

The organization policy repository must already exist as a live non-fork repository. Automatic repository creation is deliberately outside the fleet-hardening apply authority.

## Plan

Plan mode is read-only and requires one explicit organization and expected environment:

```bash
node apps/cli/src/hardening.mjs hardening plan \
  --organization chapter-publishing-test \
  --environment test \
  --include-repositories \
  --max-repositories 200 \
  --output fleet-hardening-plan.json
```

`FLEET_HARDENING_APP_ID`, `FLEET_HARDENING_APP_PRIVATE_KEY`, an owner allowlist/pattern, and `HARDENING_SOURCE_REVISION` (or `GITHUB_SHA`) are required. The plan file is mode `0600` because it can contain private repository names and exact heads.

The public-repository Actions workflow is intentionally **plan-only**. It uploads only a content-free receipt containing the organization, environment, operation count, and plan digest, then deletes the detailed plan. Do not upload a private fleet plan as a public Actions artifact.

## Review and apply

A reviewed plan belongs under `plans/fleet-hardening/` in an approved private/encrypted operator channel or reviewed workspace. Apply requires the exact SHA-256 digest of that reviewed plan:

```bash
node apps/cli/src/hardening.mjs hardening apply \
  --organization chapter-publishing-test \
  --environment test \
  --plan plans/fleet-hardening/chapter-publishing-test.json \
  --plan-digest sha256:<reviewed-digest> \
  --confirm HARDEN-<change-ticket> \
  --output fleet-hardening-apply-ledger.json
```

Reruns are idempotent only when the deterministic proposal branch contains the reviewed proposal and its corresponding PR is still open. A colliding/incomplete branch fails closed. Partial failures produce a rollback ledger; they do not continue silently into later repositories.

## Test-to-production promotion

Production apply additionally requires a reviewed canary receipt under `receipts/fleet-hardening/`. The receipt must identify the configured paired test organization, production organization, tested PR number and exact tested head SHA, passed status, and the current fleet configuration. The receipt digest is supplied separately on apply.

A test-org proposal is not authority to write production. Production is a separate explicit invocation after the test proposal has passed its normal repository checks/reviews and the canary evidence has been reviewed.

## SQL authority and namespacing

Every production domain receives a stable PostgreSQL schema namespace derived from its organization name. SQL may remain in each organization, normally under `sql/namespaces/<namespace>`, while a mirrored registry lives in `declarative-migrations/declarative-postgres-migrate.rs` under `registry/sql/namespaces`. Local declarations remain authoritative for the owning domain; CI canonicalizes validated declarations with JCS, records SHA-256 digests, and rejects central/local drift. Cross-domain foreign keys must target an explicitly published interface rather than an unqualified table name.

Production and test organizations may share a namespace because they run in separate database instances or clusters. Within any one database, environment isolation must use separate databases or an explicit environment prefix; silently mixing test and production rows is prohibited.

## Repository and Kubernetes baseline

The policy covers security and CODEOWNERS files, exact-head dual-AI review gates, dependency and secret scanning, pinned CI actions, reproducible builds, SBOM/provenance, `ores-otel`, Shared Auth, Opto Sync, Zed package lifecycles, formal state machines, and black-box certification in paired `*-test` organizations. Client repositories target at least 15 languages, with Rust, Dart, and TypeScript treated as mandatory first-class targets.

Infra repositories consume contracts from `ORESoftware/k8s-cluster`, `ORESoftware/k8s-libs-and-shared-defs`, and `declarative-migrations/declarative-postgres-migrate.rs`. Each service uses a Kustomize base plus test/staging/production overlays, restricted pod security, default-deny network policy, probes, resource requests/limits, disruption budgets, autoscaling where meaningful, immutable OCI images, GitOps reconciliation, and declarative database migration gates.
