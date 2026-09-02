# PR bot live canary — 2026-09-02

This file exists only to exercise the GitHub pull-request event path safely.

Canary phase: second head after `pull_request.synchronize`.

First head: `dd1494fb38e45735cea87c36cd08360624b8cbd8`.

Expected behavior after the review control plane is activated:

- GitHub Actions validates this exact second head.
- First-head AI decisions no longer satisfy the pull request.
- `ores-review/openai` reviews this exact second head.
- `ores-review/claude` reviews this exact second head.
- `ores-review/gate` remains fail-closed until both fresh provider checks and required CI are successful.

No deployment, credential, ruleset, provider, or production resource is changed by this canary.
