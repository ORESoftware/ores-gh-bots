import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canaryEvidenceDigest,
  verifyCanaryEvidence,
} from '../packages/core/src/canary-evidence.mjs';

const first = 'a'.repeat(40);
const second = 'b'.repeat(40);

function check(role, headSha, overrides = {}) {
  const names = {
    openai: 'ores-review/openai',
    claude: 'ores-review/claude',
    gate: 'ores-review/gate',
  };
  const ids = { openai: 101, claude: 102, gate: 103 };
  return {
    name: names[role],
    app_id: ids[role],
    external_id: `${role}:example-test/review-canary#7@${headSha}`,
    head_sha: headSha,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function evidence() {
  return {
    schema_version: 'ores.review-canary.v1',
    repository: 'example-test/review-canary',
    pull_request: 7,
    app_ids: { openai: 101, claude: 102, gate: 103 },
    first_head_sha: first,
    second_head_sha: second,
    readiness: { status: 200, observed_at: '2026-09-01T12:00:00Z' },
    webhook: {
      event: 'pull_request',
      action: 'synchronize',
      delivery_id: 'delivery-2',
      observed_at: '2026-09-01T12:02:00Z',
    },
    snapshots: {
      first_head_complete: {
        observed_at: '2026-09-01T12:01:00Z',
        head_sha: first,
        checks: [check('openai', first), check('claude', first), check('gate', first)],
      },
      second_head_pending: {
        observed_at: '2026-09-01T12:02:01Z',
        head_sha: second,
        checks: [
          check('openai', second, { status: 'in_progress', conclusion: null }),
          check('gate', second, { status: 'in_progress', conclusion: null }),
        ],
      },
      second_head_complete: {
        observed_at: '2026-09-01T12:04:00Z',
        head_sha: second,
        checks: [check('openai', second), check('claude', second), check('gate', second)],
      },
    },
    ruleset: {
      name: 'ORES dual-AI review gate',
      enforcement: 'evaluate',
      branch_mode: 'all',
      targets: ['refs/heads/**'],
      required_checks: [
        { name: 'ores-review/openai', app_id: 101 },
        { name: 'ores-review/claude', app_id: 102 },
        { name: 'ores-review/gate', app_id: 103 },
      ],
    },
  };
}

test('accepts deterministic exact-SHA canary evidence', () => {
  const value = evidence();
  const firstResult = verifyCanaryEvidence(value);
  assert.equal(firstResult.ok, true, firstResult.errors.join('\n'));
  assert.match(firstResult.evidence_sha256, /^[0-9a-f]{64}$/u);

  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(canaryEvidenceDigest(reordered), firstResult.evidence_sha256);

  value.evidence_sha256 = firstResult.evidence_sha256;
  assert.equal(verifyCanaryEvidence(value).ok, true);
});

test('rejects a canary that reuses the same head SHA', () => {
  const value = evidence();
  value.second_head_sha = first;
  assert.equal(verifyCanaryEvidence(value).ok, false);
  assert.match(verifyCanaryEvidence(value).errors.join('\n'), /must differ from first_head_sha/u);
});

test('rejects a pending snapshot that already has a successful gate', () => {
  const value = evidence();
  value.snapshots.second_head_pending.checks = [
    check('openai', second),
    check('claude', second),
    check('gate', second),
  ];
  const result = verifyCanaryEvidence(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must not contain a successful gate/u);
});

test('rejects shared App identities and stale external IDs', () => {
  const value = evidence();
  value.app_ids.claude = value.app_ids.openai;
  value.snapshots.second_head_complete.checks[0].external_id = `openai:example-test/review-canary#7@${first}`;
  const result = verifyCanaryEvidence(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /three distinct GitHub App identities/u);
  assert.match(result.errors.join('\n'), /must bind openai/u);
});

test('rejects an expected digest that is not bound to the evidence', () => {
  const result = verifyCanaryEvidence(evidence(), { expectedDigest: '0'.repeat(64) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /expected_digest: does not match/u);
});
