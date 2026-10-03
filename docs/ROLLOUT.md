# Fleet rollout

## Canary

- Install Apps only in organizations whose names end in `-test`.
- Deploy the canary overlay with one replica and persistent SQLite storage.
- Run `node apps/cli/src/main.mjs fleet discover` and inspect the generated inventory.
- Run `node apps/cli/src/main.mjs rulesets apply --enforcement evaluate --branch-mode all`.
- Open a PR against a non-default branch and against the default branch.
- Push a second commit while the first review is complete. Confirm the PR now requires fresh checks for the second SHA.
- Exercise `/ores-review`, provider failure, CI pending, CI failure, and webhook replay behavior.

## Activation

Change only the canary rulesets to `active`. After an observation window, install the Apps in production organizations and repeat in batches. Keep an emergency bypass team in ruleset configuration only if organizational policy requires it; every bypass should be auditable.

`--branch-mode all` targets `refs/heads/**`. This is the requested all-branch posture and is intentionally disruptive: direct updates to existing branches may be blocked by required checks. Use `--branch-mode protected` for default and explicitly configured long-lived branches when that is the desired policy.
