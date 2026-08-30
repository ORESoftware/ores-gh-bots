# Bounded provider HTTP retries

Tracking: DEN-3793. This follow-up builds on PR #12's response ceiling and
redirect prohibition; it does not replace PR #11's credential-destination policy
or PR #7's review-input, result-schema, and check-provenance controls.

## Local retry policy

Only HTTP 429, 500, 502, 503, 504, and 529 are eligible for inline retry. A
`Retry-After` header never makes an authentication, authorization, validation,
not-found, or other permanent status retryable. `x-should-retry: false` disables
inline retry. The default is two retries, with an explicit configuration maximum
of five; changing the ceiling requires trusted caller configuration.

`Retry-After` supports nonnegative integer seconds and IMF-fixdate HTTP dates.
Malformed, negative, fractional, or ambiguous numeric-date values are ignored.
Oversized values are not passed to Node timers. A server-requested delay is never
shortened to fit the local wait ceiling or remaining deadline: the request fails
with status and `retryAfterMs` metadata instead. Without a usable header, waits
are bounded exponential delays starting at 750 ms. The default per-wait ceiling
is 10 seconds; trusted configuration can select 1 ms through 60 seconds.

`timeoutMs` is now one end-to-end deadline, not a fresh allowance for each
attempt. It covers all requests, response streaming, and retry sleeps. Caller
cancellation also interrupts those stages. Deadline checks use a monotonic clock;
HTTP-date interpretation uses wall-clock time. Abort races are observed even
when an injected transport, body reader, or sleeper does not honor its signal.

Ambiguous transport failures and malformed successful responses are not retried
inline: a POST might already have been processed or billed. This policy does not
claim exactly-once model execution. Queue-level retries and event-driven reruns
are separate controls; returning `retryAfterMs` does not by itself teach the
existing durable queue to honor that delay.

## Response and logging boundaries

The default success-body ceiling remains 2 MiB, enforced before parsing and
while reading streamed bytes. There is no unbounded `text()` fallback. The
trusted configurable ceiling must be between 1 KiB and 16 MiB. Oversized or
stalled streams are cancelled without awaiting an indefinitely hanging cancel
operation. A successful response must have a JSON media type and valid JSON;
provider-specific schema validation remains the caller's responsibility.

Non-success response bodies are discarded rather than parsed or logged, so a
transient HTML error page does not prevent status-based retry. HTTP errors retain
only the provider label, status, and parsed retry delay. Transport, cancellation,
and parsing errors have fixed safe messages and codes; upstream bodies, URLs,
headers, abort reasons, and nested exception causes are not retained.

The provider label is trusted application configuration, not repository input.
All provider POSTs still use `redirect: 'error'`.

## Verification and rollout

Run `node --test test/provider-http-bounds.test.mjs test/provider-retry-deadlines.test.mjs`.
The tests use fake credentials, local streams, and injected transports; they do
not contact providers or consume model budget.

Before merge, require independent review of the exact head and repository CI.
The stack must preserve PR #12, then be retargeted onto main after its base lands.
No App registration, credential provisioning, ruleset activation, deployment, or
live canary is performed by these code changes. GitHub-client HTTP bounds,
queue-wide retry semantics, SQLite recovery, and deployment hardening remain
separate DEN-3793 acceptance criteria.

Provider error references:
- https://developers.openai.com/api/docs/guides/error-codes
- https://platform.claude.com/docs/en/api/errors
