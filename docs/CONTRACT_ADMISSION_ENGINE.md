# Contract admission in the review engine

The review engine can require exact Contract IR projection evidence in addition
to independent provider reviews and configured CI. This is an admission control,
not another compiler or schema authority.

## Authority model

- Independently authored TypeSpec and independently authored JSON Schema remain
  peer authorities.
- TypeSpec-generated JSON Schema remains comparison evidence only.
- The parity report, Contract IR, projection manifests, transports, clients,
  database mappings, fixtures, and runtime-validator receipts remain derived
  evidence.
- Pull-request content cannot select its own evidence paths, producer identity,
  producer revisions, required projection kinds, or freshness window.

## Trusted policy

Set `CONTRACT_ADMISSION_POLICY_PATH` to an operator-owned regular JSON file that
validates as `ores.gh-bots.contract-admission-policy/v1`. Leaving the variable
empty preserves the existing provider-and-CI-only gate.

The policy maps an exact `OWNER/REPOSITORY` to:

- a reviewed allowlist of immutable
  `ORESoftware/typespec-json-schema-validator` commits;
- the expected producer check name and GitHub App ID;
- a maximum producer-check age;
- explicit report and Contract IR paths;
- a byte ceiling; and
- one manifest path and scope policy for each required projection kind.

The file loader rejects symbolic links, hard links, non-regular files, invalid
UTF-8, duplicate JSON keys, excessive nesting, unsupported fields, duplicate
repositories, duplicate producer commits, duplicate projection kinds, unsafe
paths, and reused artifact paths. Evidence paths under `.ores/` are prohibited:
that directory is reserved for ignored local agent wiring and cannot hold
committed exact-head evidence. The disabled example is
`config/contract-admission-policy.example.json`; the closed Draft 2020-12 schema
is `config/contract-admission-policy.schema.json`.

## Exact-head loading

For a configured repository the engine:

1. invalidates persisted receipts from all earlier pull-request heads;
2. rejects deleted or fork head repositories before reading evidence;
3. requires the configured producer check on the exact head;
4. pins that check to the configured GitHub App ID, successful conclusion, and
   freshness window;
5. requires the check to remain valid through the next reconciliation interval,
   preventing a success check from aging out before the control plane can
   replace its aggregate decision;
6. fetches configured files through relative same-origin GitHub API paths at the
   exact 40-character commit SHA;
7. uses inline Contents API bytes when available and otherwise follows the
   Contents metadata to the same immutable Git blob through a relative API path;
8. verifies file type, response path, Git blob identity and size, byte boundary,
   base64 encoding, exact decoded size, and UTF-8;
9. rejects ambiguous manifest JSON before semantic verification;
10. invokes `verifyContractProjectionAdmission` with the trusted repository,
    head SHA, producer-commit allowlist, scope requirement, exact report bytes,
    and exact Contract IR bytes; and
11. persists a bounded receipt keyed by repository, pull request, head SHA, and
    projection kind.

A missing or in-progress producer check keeps the projection pending. A foreign,
failed, stale, expiring, or expired producer check fails closed. Deterministic
missing or malformed artifact responses become bounded failures. Rate limits,
server failures, and statusless transport exceptions stay in the queue retry
path instead of being recorded as semantic contract failures.

## Final publication and freshness fences

After provider, CI, and projection evaluation, the engine fetches the pull
request again immediately before publishing the aggregate gate. If the head
moved, it:

- deletes all receipts for the superseded head;
- queues a gate job for the new head;
- completes the old gate as neutral with both SHAs; and
- publishes no success or failure decision for the stale head.

The existing installation reconciler also examines completed gates for configured
repositories. It queues a new gate evaluation when a required receipt is
missing, bound to the wrong head/repository/kind or producer identity, or will
expire before the next reconciliation interval. An in-progress gate is left
alone so producer-check completion remains the primary event-driven wake-up.

Serialized receipt objects are audit evidence only. The gate consumes the
immutable in-process verifier results produced during the current evaluation;
serialized or reconstructed results require explicit repository/head rebinding.

## Persistence and logging

SQLite stores contract receipts separately from provider reviews. Receipts are
replaced only for the same repository, pull request, head, and projection kind;
they survive process restart, expire with their producer check, and are removed
when a new head is observed.

Logs and check summaries expose only bounded repository, pull request, head,
projection, state, and rule identifiers. Parity-report, Contract IR, manifest,
and authored declaration content are never logged.

## Rollout boundary

The committed example is disabled and no repository is activated by this
change. Initial rollout belongs in one paired test organization/repository with
a separately reviewed trusted policy, live independent App identities, and
exact-head canary evidence. This implementation does not register Apps, mutate
rulesets, generate transport code, merge consumer pull requests, or authorize a
fleet-wide rollout.

Related work:

- `ORESoftware/ores-gh-bots#29`
- `ORESoftware/ores-gh-bots#30`
- `ORESoftware/typespec-json-schema-validator#20`
- Linear `DEN-3828` and `DEN-3830`
