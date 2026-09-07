# Contract projection admission

`ores-gh-bots` is a consumer of the parity evidence produced by
`ORESoftware/typespec-json-schema-validator`. It is not another schema compiler
and it is not an authority over application data shapes.

The source model is deliberately symmetric:

- independently authored TypeSpec is an authority;
- independently authored JSON Schema is an authority;
- TypeSpec-generated JSON Schema is comparison evidence only;
- the Contract IR and every transport, runtime, SQL, ORM, client, fixture, and
  documentation artifact are downstream projections.

A copied `status: passed` value is never sufficient. Before a generated change
can satisfy a merge requirement, the caller should run
`verifyContractProjectionAdmission` with all of the following:

1. the exact parity-report bytes;
2. the exact Contract IR bytes;
3. a closed `ores.gh-bots.contract-projection-admission/v1` manifest;
4. the current consumer `OWNER/REPOSITORY` and pull-request head SHA, fetched
   immediately before evaluation; and
5. a reviewed allowlist of immutable validator producer commits supplied by
   trusted configuration, not by the pull request.

The verifier checks the producer's canonical JSON digest convention, report
coverage, zero-finding status, receipt/run binding, Contract IR self-digest,
peer-authority roles, all three input digests and file closures, declaration and
assertion digests, scope accounting, and exact raw artifact hashes. Paths are
required to be normalized and relative so evidence cannot name files outside
its reviewed checkout.

## Projection-specific requirements

Every projection records output, emitter configuration, representation-loss,
compiler, fixture, and sibling-test evidence digests. Additional requirements
are fail-closed:

- Protobuf, gRPC, and Connect require a permanent field-lock digest.
- RPC/API projections require an authored operation-inventory digest.
- A projection that records `runtimeValidatorRequired: true` must provide an
  execution-evidence digest for that validator.
- Sibling tests are bound to an immutable repository commit.

The verifier requires a complete admitted declaration scope by default.
`requireCompleteScope: false` is available only for a caller that has separately
reviewed explicit excluded and out-of-scope declarations; it does not change the
Contract IR's own `complete: false` result.

## Merge-gate integration

`evaluateGate` accepts optional `projectionAdmissions` and
`requiredProjectionKinds`. Existing callers that require no projections keep
identical provider/CI behavior. A required kind is pending when evidence is
absent and fails when evidence is duplicated, malformed, or non-admissible.

The verification object is not a trust identity by itself. Production callers
must still bind the check context to the configured GitHub App identity and
re-fetch the current pull-request head before the merge effect. The verifier
performs no network request, code generation, approval, merge, publication,
provider mutation, or business-policy inference.

## Manifest authority

The JSON Schema at `config/contract-projection-admission.schema.json` documents
the closed manifest envelope. The executable JavaScript verifier remains the
semantic gate for cross-artifact relationships that JSON Schema alone cannot
prove.

Related work:

- `ORESoftware/typespec-json-schema-validator#20`
- `ORESoftware/ores-gh-bots#28`
- Linear `DEN-3828` and `DEN-3830`
