# Pull-request dependency gate

`ores-gh-bots` can make the existing `ores-review/gate` depend on one or more
other pull requests. There is no second required status check: branch/ruleset
protection continues to require `ores-review/gate`, and PR-dependency evidence
is one of the inputs to that aggregate gate.

## Declaration syntax

Put one dependency on each PR-body line:

```text
Depends on: owner/repo#123
Depends on: owner/repo#456 @ v1.2.3
Depends on #789
```

The following directive names are accepted for compatibility with existing
stacked-PR conventions: `Depends on`, `depends-on`, `dependency`, `requires`,
`merge-after`, and `stacked-on`.

A leading `v` on an exact version is normalized away, so `v1.2.3` and `1.2.3`
mean the same version. Conflicting version requirements for the same PR are an
invalid declaration and fail the downstream gate.

## What passing means

For every non-cyclic dependency, the downstream gate re-fetches the upstream PR
from GitHub and binds the result to the upstream PR's exact current head SHA.
The dependency passes only when:

1. the upstream PR exists and is visible to the fleet Orchestrator App;
2. it is not a draft and is not closed-unmerged;
3. its exact current head has a successful `ores-review/gate` check;
4. that gate was published by the configured Gate App identity and has the
   exact expected gate `external_id`; and
5. when an exact version is requested, the upstream head declares that exact
   version in machine-readable repository metadata.

The version source order is `.zpkg.toml`, `package.json`, `Cargo.toml`,
`pubspec.yaml`, then `gleam.toml`. PR titles are deliberately not version
authority.

An open upstream PR may satisfy the dependency once its exact current head is
green; it does not have to merge first. A merged upstream PR can also satisfy
the dependency using the gate and version evidence attached to its PR head.

## Re-evaluation

The Orchestrator persists only acyclic reverse dependency edges. Upstream PR
webhooks and upstream `ores-review/gate` create/rerequest/complete webhooks
enqueue fresh gate jobs for downstream PRs. A successful downstream gate
therefore cannot remain green merely because an older upstream head was green.

Closed downstream PRs have their reverse edges removed.

## Cycle policy

The dependency graph itself is never allowed to contain a cycle. If adding a
PR dependency would close a cycle (including a self-dependency), that edge is
**ignored** and the gate records a successful informational state such as:

```text
dependency cycle detected; edge ignored by policy
```

In other words, cycles do not deadlock or fail PRs. The edge that would make the
persisted graph cyclic is omitted, while every non-cyclic dependency continues
to be enforced normally.

## GitHub App permission

Exact version verification reads manifests at the upstream head SHA. The fleet
Orchestrator App therefore needs `Contents: read` in addition to its existing
checks/pull-request metadata permissions. No PAT or workflow-local fleet token
is required.
