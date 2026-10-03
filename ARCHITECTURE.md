# Architecture

## Trust boundaries

The webhook server trusts only requests with a valid GitHub signature and an allowed repository owner. Pull-request metadata and all repository content remain untrusted even after signature verification because contributors control them.

The orchestrator uses one App only for event intake and read access. Separate reviewer Apps may publish the OpenAI and Claude checks, allowing rulesets to pin each required context to a distinct GitHub integration ID. The gate App publishes only `ores-review/gate`.

## Event flow

1. GitHub sends a signed webhook.
2. The server validates the signature, owner, delivery ID, event, action, and command authorization.
3. A SHA-keyed review or gate job is inserted into SQLite.
4. The worker leases the job and re-fetches the PR.
5. If the head SHA moved, the stale job is discarded and a current-SHA job is queued.
6. Provider check runs move to `in_progress`.
7. A bounded and redacted review context is sent independently to OpenAI and Claude.
8. Results are validated against the local schema and persisted.
9. Provider checks complete; non-approval is merge-blocking.
10. The aggregate gate verifies both provider results and configured CI contexts for the same SHA.

## Failure behavior

Provider errors, invalid structured output, missing App installation, stale SHA, or required CI failure never produce a successful gate. Rate limits and transient failures are retried with backoff. The reconciler repairs deliveries missed during downtime.
