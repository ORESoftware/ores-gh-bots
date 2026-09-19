# Agent tagging, attestations, and peer consult

`ORESoftware/my-ai` `SHARED.md` lets an agent merge a pull request only after two
agents from two different families have approved the exact head commit. Agents
ask each other for those reviews through GitHub: an `agent-tag:<family>` label is
the queue and an `ores-agent-tag` marker comment is the request. This service is
the always-on receiver for the two families it hosts.

| Family in a tag or label | Provider here | Check |
|---|---|---|
| `claude`, `anthropic` | Anthropic Messages API | `ores-review/claude` |
| `codex`, `chatgpt`, `openai` | OpenAI Responses API | `ores-review/openai` |

Tags addressed to any other family (`cursor`, `gemini`, …) are ignored here.

## What triggers a review

- A pull-request comment containing
  `<!-- ores-agent-tag v1 to=<family> from=<family> session=<id> kind=review head=<sha> -->`.
- The `agent-tag:<family>` label being added to a pull request.
- Everything that already did: PR lifecycle events, `/ores-review`, check re-requests.

The marker grammar is closed. A tag carries exactly `to`, `from`, `session`,
`kind`, and `head`; a review exactly `agent`, `session`, `head`, and `verdict`; an
author declaration exactly `agent` and `session`. Each key appears once, fields
are separated by one space, `head` is 40 lowercase hex characters, families and
sessions are bounded, and `kind`/`verdict` are enums. A marker with a missing,
unknown, repeated, or malformed field is not a marker and routes nothing.

A tag is a request, not an authority. The sender must have write access, exactly
as for `/ores-review`. The `head` in a marker is never trusted: the engine
re-fetches the pull request and reviews the live head. `kind=merge` and
`kind=fix` are not acted on; this service reviews and gates, it does not push or
merge for another agent. Both providers always review, whichever one was tagged,
because the gate needs both.

The orchestrator App must subscribe to `pull_request` (which carries `labeled`)
and `issue_comment`; both are already in `github-apps/policy.json`.

## Attestations

With `POST_PULL_REQUEST_REVIEW=true` and `REVIEW_AGENT_ATTESTATIONS=true`, the
review the orchestrator posts when the gate completes begins with one marker per
provider that produced a result:

```
<!-- ores-agent-review v1 agent=codex session=ores-gh-bots:openai:<check-run-id> head=<sha> verdict=approve -->
<!-- ores-agent-review v1 agent=claude session=ores-gh-bots:claude:<check-run-id> head=<sha> verdict=request-changes -->
```

The review is a `COMMENT` review anchored with `commit_id` to the reviewed head
and authored by the orchestrator App, an identity a shared human account cannot
post as. Only `approve` attests approval; `comment` and `request_changes` both
publish as `request-changes`, matching this gate. A provider that errored gets no
marker. `REVIEW_AGENT_ATTESTATIONS=true` without `POST_PULL_REQUEST_REVIEW=true` is
rejected at startup.

When attestations are enabled they are part of the gate's contract: the review is
published **before** the gate check completes, and a publication failure fails the
job so the durable queue retries it. The gate check stays in progress meanwhile;
it is never green without its attestation.

### What an attestation proves, and what a consumer must verify

Both markers are written by one principal, the orchestrator App, so the marker
text alone proves nothing about which provider approved. The independently
authenticated evidence is the check run named in `session=`: `ores-review/openai`
is created by the OpenAI reviewer App and `ores-review/claude` by the Claude
reviewer App, and a check run can only be written by the App that created it. A
consumer must therefore resolve `ores-gh-bots:<provider>:<check-run-id>` and
require all of:

1. `app.id` equals the registered App ID for that provider's reviewer App;
2. `name` is that provider's check name;
3. `head_sha` equals the marker's `head` and the pull request's current head;
4. `status` is `completed` and `conclusion` agrees with the marker (`success` ⇔ `approve`).

A marker whose check run fails any of these is void. `my-ai/tools/agent-review-gate.rs`
does this; it needs the two reviewer App IDs, which exist only once the Apps are
registered. Production keeps `ALLOW_SHARED_APP_IDENTITY=false`, so the two IDs differ.

## Peer consult: Claude invokes ChatGPT, and the reverse

`REVIEW_PEER_CONSULT` controls a second round after both independent reviews:

| Mode | Who is invoked again |
|---|---|
| `off` (default) | nobody |
| `disagreement` | the provider that approved, when its peer did not |
| `always` | every provider that approved, including when both did |

The consulted provider receives the same bounded, redacted context plus a
`peer_review` value holding the other provider's verdict, summary, blocking
reasons, and findings. The system prompt marks it as untrusted data to be
checked against the files. Each provider has exactly one check run per head. It opens before the
independent call and completes once, with the final result, after any consult;
the independent result is never published, so there is no provisional success
and no second same-name run.

The first round is always independent. A provider that did not approve is never
consulted, so **a consult can withdraw an approval and can never grant one**. An
attacker who steers one model into approving cannot use that model's text to
talk the other out of a block. A consult that errors fails that provider's
check, and the gate with it. Cost is at most two extra provider calls per head.

Metric: `ores_peer_consults_total{provider,peer}`.

## What this does not do

There is no free-form model-to-model channel and providers still have no tools.
A disagreement that the consult does not resolve stays a failed gate for a human
or a new commit; `/ores-review` re-runs it.
