# Changelog

## 0.1.0 — 2026-08-14

- Add signed, event-driven GitHub App webhook intake for pull-request lifecycle events.
- Add independent OpenAI and Claude structured reviews bound to the exact PR head SHA.
- Add a fail-closed aggregate check that can include configured GitHub Actions contexts.
- Add a durable SQLite/WAL queue, retries, leases, delivery deduplication, and reconciliation.
- Add GitHub App manifests, ruleset tooling, pinned CI, Actions offload, Docker, Kubernetes, SOPS, Nix, and Just assets.
