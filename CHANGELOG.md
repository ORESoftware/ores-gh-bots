# Changelog

## Unreleased

- Add a dedicated least-privilege merge-reaper GitHub App and 01:00 America/Chicago recovery workflow.
- Require 55-hour age, explicit opt-in, exact-SHA gate identity, independent green CI, resolved reviews, clean mergeability, and dependency order.
- Re-fetch all mutable evidence before at most three sequential exact-SHA merges.

## 0.1.0 — 2026-08-14

- Add signed, event-driven GitHub App webhook intake for pull-request lifecycle events.
- Add independent OpenAI and Claude structured reviews bound to the exact PR head SHA.
- Add a fail-closed aggregate check that can include configured GitHub Actions contexts.
- Add a durable SQLite/WAL queue, retries, leases, delivery deduplication, and reconciliation.
- Add GitHub App manifests, ruleset tooling, pinned CI, Actions offload, Docker, Kubernetes, SOPS, Nix, and Just assets.
