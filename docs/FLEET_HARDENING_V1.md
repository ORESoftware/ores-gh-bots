# ORES fleet hardening v1

This control plane applies one idempotent policy to every accessible repository while preserving organization-local ownership of code and SQL.

## SQL authority and namespacing

Every production domain receives a stable PostgreSQL schema namespace derived from its organization name. SQL may remain in each organization, normally under `sql/namespaces/<namespace>`, while a mirrored registry lives in `declarative-migrations/declarative-postgres-migrate.rs` under `registry/sql/namespaces`. Local declarations remain authoritative for the owning domain; CI canonicalizes validated declarations with JCS, records SHA-256 digests, and rejects central/local drift. Cross-domain foreign keys must target an explicitly published interface rather than an unqualified table name.

Production and test organizations may share a namespace because they run in separate database instances or clusters. Within any one database, environment isolation must use separate databases or an explicit environment prefix; silently mixing test and production rows is prohibited.

## Repository baseline

The policy covers security and CODEOWNERS files, exact-head dual-AI review gates, dependency and secret scanning, pinned CI actions, reproducible builds, SBOM/provenance, `ores-otel`, Shared Auth, Opto Sync, Zed package lifecycles, formal state machines, and black-box certification in paired `*-test` organizations. Client repositories target at least 15 languages, with Rust, Dart, and TypeScript treated as mandatory first-class targets.

## Kubernetes baseline

Infra repositories consume contracts from:

- `ORESoftware/k8s-cluster`
- `ORESoftware/k8s-libs-and-shared-defs`
- `declarative-migrations/declarative-postgres-migrate.rs`

Each service uses a Kustomize base plus test, staging, and production overlays; restricted pod security; default-deny network policy; probes; resource requests/limits; disruption budgets; autoscaling where meaningful; immutable OCI images; GitOps reconciliation; and declarative database migration gates.

## Commands

Plan is the default and performs no writes:

```bash
GITHUB_ADMIN_TOKEN=... npm run hardening -- plan --limit 50
```

Apply organization policies, create declared missing repositories, and write per-repository policy markers:

```bash
GITHUB_ADMIN_TOKEN=... npm run hardening -- apply \
  --confirm HARDEN-<change-ticket> \
  --ensure-repositories \
  --repositories \
  --continue
```

Use `--organization chapter-publishing,chapter-publishing-test` for a canary. Test organizations are always sorted before production organizations.

## Chapter Publishing reference implementation

`chapter-publishing` is the reference domain. The fleet config declares `chptr-e2e`, `chptr-worker.rs`, `chptr-mcp-server.rs`, and `chptr-astro`. The test organization declares dedicated canary, contract, load, chaos, fixture, Kubernetes smoke, and security repositories. Its SQL namespace is `chapter_publishing`, and its infra repository is `chapter-publishing/chptr-infra`.
