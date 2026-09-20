# Changelog

## Unreleased

- Route `ores-agent-tag` review requests and `agent-tag:<family>` labels (ORESoftware/my-ai two-review gate) to an authorized exact-head review.
- Optionally publish `ores-agent-review` attestations for both providers in the head-anchored PR review (`REVIEW_AGENT_ATTESTATIONS`).
- Add an opt-in peer consult (`REVIEW_PEER_CONSULT`) in which a provider that approved is invoked again with the other provider's review; it can withdraw an approval and never grant one.

## 0.1.0 — 2026-08-14

- Add signed, event-driven GitHub App webhook intake for pull-request lifecycle events.
- Add independent OpenAI and Claude structured reviews bound to the exact PR head SHA.
- Add a fail-closed aggregate check that can include configured GitHub Actions contexts.
- Add a durable SQLite/WAL queue, retries, leases, delivery deduplication, and reconciliation.
- Add GitHub App manifests, ruleset tooling, pinned CI, Actions offload, Docker, Kubernetes, SOPS, Nix, and Just assets.
