# Exact-tree CI carrier and merge safety

An authorized, private, cross-organization test carrier is a **test runner**, not
a second source of merge permissions. A successful carrier execution never
substitutes for source-repository review, protected-branch checks, or a trusted
check-run/status published through approved source-side governance.

## Carrier acceptance rules

1. Check the source PR is open and identify its current immutable head commit
   and target base commit. Reject draft or superseded heads for merge admission.
2. Check the target carrier remains private, non-fork, and explicitly authorized.
   Verify an approved runner is available; past green runs are not proof of
   remaining GitHub Actions capacity.
3. Replicate the complete source Git tree in the authorized carrier, including
   blob identities, executable modes, symlinks and paths. Verify the **root Git
   tree SHA** matches; comparing patches or filenames alone is insufficient.
4. Run only a reviewed carrier-owned test entrypoint with read-only repository
   permissions, disabled checkout credential persistence, no production secrets,
   no privileged workflows inherited from the copied source, bounded resource
   limits, and an explicit source-head-to-carrier receipt.
5. Treat skipped, neutral, pending, unexecuted, missing, stale, or failed tests
   as **not passing**. Authenticate exact-tree provenance and the test verdict.
6. Recheck source head, base, independent current-head human approval, required
   source checks, review threads, dependencies and explicit merge opt-in
   immediately before a protected GitHub merge operation.

## Reaper policy

The merge reaper rejects PRs whose titles identify CI-only work, exact-tree
carriers, or explicit do-not-merge instructions. It also rejects temporary
`ci-mirror/`, `ci/exact/`, `ci-source-free/`, `carrier/`, exact-SHA
`ci/oreslang-<40 hex>`, and `ci/authorized-<40 hex>` branches.

Labels `do-not-merge`, `ci-only`, `test-only`, `test-carrier`, and
`private-mirror` always exclude a PR even if a custom policy omits them.
Live `apply` additionally requires explicit per-PR opt-in and an independent
human approval bound to the current source head; these gates cannot be disabled
by a custom policy or by a carrier success.

This is an admission/safety contract, not evidence that any particular funded
carrier, private-tree transfer, or source compiler test has succeeded.
