# Exact-SHA canary evidence

The review control plane must not move from source-complete to fleet-active on a narrative checklist alone. A canary produces one redacted JSON artifact that proves the exact-head and independent-App invariants for a pull request in a paired `*-test` owner.

The contract is `config/canary-evidence.schema.json`. The runtime verifier adds semantic checks that JSON Schema cannot express by itself: distinct App identities, first/second SHA inequality, exact external IDs, chronological observations, an unsatisfied gate immediately after `synchronize`, successful fresh checks for the second SHA, and App-ID-pinned ruleset read-back.

## Collection sequence

1. Deploy the reviewed canary image and record a successful `/readyz` response.
2. Open a canary pull request and wait for `ores-review/openai`, `ores-review/claude`, and `ores-review/gate` to complete successfully on the first head SHA.
3. Push a second commit. Record the `pull_request.synchronize` delivery ID and capture the second head while its fresh gate is absent or non-successful. First-head success is not valid evidence for this snapshot.
4. Wait for both providers and the aggregate gate to complete successfully on the second head SHA.
5. Read back the repository ruleset, including enforcement mode, branch targets, required check names, and the pinned App ID for each check.
6. Store only redacted metadata. The evidence file must never contain App private keys, provider keys, webhook secrets, installation tokens, PATs, request bodies, or model prompts.

Use only the latest ORES check run for each check name in a snapshot. Other CI checks may be omitted.

## Verify and bind the artifact

```bash
npm run cli -- canary verify --evidence ./result/canary-evidence.json
```

The command emits `evidence_sha256`, calculated from a recursively key-sorted JSON representation with any declared `evidence_sha256` field removed. Put that digest in the reviewed activation change ticket, then re-run with the reviewed value:

```bash
npm run cli -- canary verify \
  --evidence ./result/canary-evidence.json \
  --expected-digest <64-hex-reviewed-digest>
```

A mismatch, stale SHA, shared App identity, foreign check writer, prematurely successful second-head gate, missing fresh approval, or ruleset pin drift fails closed with exit status 1.

Verification does not register Apps, provision secrets, deploy workloads, apply rulesets, or authorize production expansion. It makes the human-owned activation decision reproducible and reviewable.
