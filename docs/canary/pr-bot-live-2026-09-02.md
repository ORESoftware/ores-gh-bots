# PR bot live canary — 2026-09-02

This file exists only to exercise the GitHub pull-request event path safely.

Canary phase: first head.

Expected behavior after the review control plane is activated:

- GitHub Actions validates this exact head.
- `ores-review/openai` reviews this exact head.
- `ores-review/claude` reviews this exact head.
- `ores-review/gate` remains fail-closed until both provider checks and required CI are successful.
- A second commit invalidates every prior review decision.

No deployment, credential, ruleset, provider, or production resource is changed by this canary.
