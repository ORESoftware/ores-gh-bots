# Negative knowledge

Approaches that were tried in this repository and deliberately abandoned. They
are recorded here so they are not re-attempted by a future contributor or agent
who finds them on an old branch and mistakes staleness for novelty.

## Do not interpolate workflow inputs into a `run:` command line

`agent/den-3773-event-driven-review-bootstrap` invoked the runner as:

```yaml
run: >-
  node apps/runner/src/main.mjs
  --owner "${{ inputs.owner }}"
  --repo "${{ inputs.repo }}"
  --pr-number "${{ inputs.pr_number }}"
  --head-sha "${{ inputs.head_sha }}"
  --installation-id "${{ inputs.installation_id }}"
  --reason "${{ inputs.reason }}"
```

`${{ }}` is substituted into the shell script *before* the shell parses it, so
any input carrying shell metacharacters is executed, not passed. `reason` is the
most exposed of these because it is the most free-form. `main` deliberately
replaced this with environment variables:

```yaml
env:
  REVIEW_OWNER: ${{ inputs.owner }}
  ...
  REVIEW_REASON: ${{ inputs.reason }}
run: node apps/runner/src/main.mjs
```

Values delivered through `env:` are never parsed by the shell. This also matches
the repository rule that one-time callback codes and state stay out of `argv`,
where they would be visible to any process that can read `/proc`. Do not
"simplify" the env block back into flags.

## Do not re-add `check_suite` to the orchestrator's `default_events`

The same branch subscribes the orchestrator App to `check_suite` in addition to
`check_run`. `main` subscribes to `check_run` only, and `packages/core/src/events.mjs`
records why: `check_run.completed` is the canonical CI re-evaluation trigger, and
GitHub emits `check_suite.completed` for the same underlying activity. Subscribing
to both delivers two webhooks for one event and doubles the queue work with no
extra signal. `test/github-app-policy.test.mjs` pins this, so re-adding it turns
the suite red rather than failing silently.

## `npm run verify` is a composite, not a single script

The branch defines `"verify": "node scripts/verify-repository.mjs"`. `main` splits
this into `verify:repository` and `verify:github-apps` with `verify` running both.
Reverting to the single-script form silently stops verifying App policy.
