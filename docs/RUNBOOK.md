# Operations runbook

## Signals

- `ores_webhooks_rejected_total`: signature, owner, or payload failures.
- `ores_jobs_failed_total{dead="true"}`: exhausted work requiring intervention.
- `ores_provider_errors_total`: provider/API/schema failures.
- `ores_stale_reviews_total`: normal when commits arrive during a review; sustained growth indicates provider latency.
- `/readyz`: process has initialized workers and HTTP intake.

## Incident actions

1. Keep rulesets active unless the bot is unable to publish checks and business continuity requires a documented bypass.
2. Restore provider or GitHub App credentials through the encrypted secret workflow; never paste keys into issues, PRs, or logs.
3. Re-run a check from its **Re-review** action or add `/ores-review` as a collaborator with write access.
4. For missed webhooks, run the reconciler or restart the service; it discovers missing current-SHA checks.
5. Inspect dead jobs in SQLite and repair the underlying error before re-enqueueing.

## Rotation

Rotate App private keys, webhook secrets, provider credentials, and any temporary admin token independently. The service caches installation tokens only in memory and refreshes them before expiration.

## Rollback

Ruleset changes are independent from service deployment. Roll back the image first. Change enforcement to `evaluate` or `disabled` only through a reviewed change with an incident reference. Never delete the required contexts while stale successful checks might still be visible on old SHAs.
