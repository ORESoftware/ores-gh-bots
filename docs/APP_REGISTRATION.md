# GitHub App registration

Register the manifests in `github-apps/` under the account that should own each App. The recommended production shape is:

1. `ORES Review Orchestrator` — receives webhooks, reads pull requests/content, and writes orchestration comments/checks.
2. `ORES OpenAI Reviewer` — writes only the OpenAI check.
3. `ORES Claude Reviewer` — writes only the Claude check.
4. `ORES Review Gate` — writes only the aggregate gate.

Install all four Apps on the same repositories. Set their App IDs and private keys in the runtime secret. If separate reviewer credentials are omitted, the orchestrator credentials are used as a development fallback; production rulesets should pin each context to the intended integration ID.

The webhook URL is `https://YOUR_HOST/webhooks/github`. Subscribe the orchestrator to pull requests, check runs, check suites, issue comments, installation, installation repositories, and ping.
