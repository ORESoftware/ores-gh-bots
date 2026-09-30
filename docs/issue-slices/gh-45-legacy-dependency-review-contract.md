# legacy/compatibility dependency review

Driver: `ORESoftware/ores-gh-bots#45`

This is a bounded review contract for an independently mergeable slice of the driver issue. It does not claim full rollout or implementation.

## Invariants

- Consume an immutable reviewed repository-classification registry.
- Inspect only changed dependency-bearing surfaces with bounded deterministic parsing.
- Flag newly introduced mutable references to compatibility/legacy repositories and show canonical replacements when known.
- Allow historical immutable references only through explicit reviewed policy exceptions.

## Verification

- Bind evidence to the exact PR/source revision.
- Add or retain fail-closed negative coverage around untrusted inputs.
- Keep credentials and sensitive payloads out of fixtures, logs, and review text.
- Treat missing or zero-step CI as missing evidence.

## Non-goals

This contract does not bypass branch protection or create new secret-delivery channels.
