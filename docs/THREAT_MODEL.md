# Threat model

## Protected assets

- GitHub App private keys and installation tokens.
- OpenAI and Anthropic API keys.
- Source code from private repositories.
- Merge integrity of protected branches.

## Primary threats and controls

- **Forged webhooks:** HMAC-SHA256 validation over raw bytes and delivery-ID de-duplication.
- **Prompt injection in code or PR text:** immutable system policy, JSON data envelopes, no tool access for providers, and no execution of PR code.
- **Secret exfiltration:** regex redaction before provider calls, redaction of outputs/errors, bounded context, and no environment dump in logs.
- **Stale approval reuse:** all persisted results and checks are keyed to the exact head SHA; the worker re-fetches the PR before and after provider calls.
- **Status spoofing:** rulesets may specify each expected integration ID.
- **Webhook loss:** periodic reconciliation.
- **Replay or duplicate delivery:** delivery table plus idempotent SHA jobs.
- **Fork compromise:** central service reads GitHub-provided diffs only and never runs fork code.
- **Agent tag abuse:** `ores-agent-tag` markers and `agent-tag:*` labels only request a review; the sender needs write access like `/ores-review`, the marker's head SHA is ignored in favour of the live head, and marker parsing is closed and bounded. Attestations are published by the orchestrator App in a review anchored to the reviewed commit; because one principal writes both markers, consumers must verify each marker's check run against the provider reviewer App ID, check name, head SHA, and conclusion (`docs/AGENT_TAGGING.md`). With attestations enabled, publication precedes gate completion and its failure fails the job.
- **Cross-model persuasion:** a peer consult shows one provider the other's review as untrusted data. Only a provider that approved is consulted, so a consult can withdraw an approval and can never grant one; a failed consult fails that provider's check.
- **Provider outage or malformed output:** fail closed, retry transient faults, and publish a failed check with a redacted reason.
