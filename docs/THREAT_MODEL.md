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
- **Provider outage or malformed output:** fail closed, retry transient faults, and publish a failed check with a redacted reason.
