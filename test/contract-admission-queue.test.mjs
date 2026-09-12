import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteQueue } from '../packages/queue/src/index.mjs';

function result(headSha = 'a'.repeat(40), kind = 'protobuf') {
  return {
    schema: 'ores.gh-bots.contract-projection-admission-verification/v1',
    repository: 'O/R',
    headSha,
    projectionKind: kind,
    manifestDigest: '1'.repeat(64),
    status: 'passed',
    admissible: true,
    reportRunId: '2'.repeat(64),
    contractIrId: '3'.repeat(64),
    findings: [],
  };
}

function record(queue, overrides = {}) {
  const headSha = overrides.headSha ?? 'a'.repeat(40);
  const projectionKind = overrides.projectionKind ?? 'protobuf';
  return queue.recordContractAdmission({
    owner: 'O',
    repo: 'R',
    prNumber: 2,
    headSha,
    projectionKind,
    result: overrides.result ?? result(headSha, projectionKind),
    producerCheckRunId: overrides.producerCheckRunId ?? 42,
    producerCheckName: 'contract-parity/verify',
    producerAppId: 12345,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  });
}

test('persists immutable admission receipts per exact head and projection kind', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    const stored = record(queue);
    assert.equal(stored.projectionKind, 'protobuf');
    assert.equal(stored.producerCheckRunId, 42);
    assert.equal(stored.result.admissible, true);
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.result), true);
    assert.equal(Object.isFrozen(stored.result.findings), true);

    record(queue, { projectionKind: 'dart', producerCheckRunId: 43 });
    const all = queue.getContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'a'.repeat(40),
    });
    assert.deepEqual(all.map((entry) => entry.projectionKind), ['dart', 'protobuf']);
  } finally {
    queue.close();
  }
});

test('replaces one exact-head projection receipt without duplicating it', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    record(queue, { producerCheckRunId: 41 });
    record(queue, { producerCheckRunId: 42, result: { ...result(), manifestDigest: '9'.repeat(64) } });
    const all = queue.getContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'a'.repeat(40),
    });
    assert.equal(all.length, 1);
    assert.equal(all[0].producerCheckRunId, 42);
    assert.equal(all[0].result.manifestDigest, '9'.repeat(64));
  } finally {
    queue.close();
  }
});

test('invalidates every receipt from an earlier pull-request head', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    record(queue, { headSha: 'a'.repeat(40) });
    record(queue, { headSha: 'b'.repeat(40) });
    assert.equal(queue.invalidateContractAdmissions({
      owner: 'O', repo: 'R', prNumber: 2, currentHeadSha: 'b'.repeat(40),
    }), 1);
    assert.equal(queue.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'a'.repeat(40), projectionKind: 'protobuf',
    }), null);
    assert.equal(queue.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'b'.repeat(40), projectionKind: 'protobuf',
    })?.headSha, 'b'.repeat(40));
  } finally {
    queue.close();
  }
});

test('survives a queue restart and prunes expired receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ores-contract-admission-queue-'));
  const path = join(directory, 'queue.sqlite');
  try {
    const first = new SqliteQueue({ path });
    record(first, { expiresAt: Date.now() + 60_000 });
    first.close();

    const second = new SqliteQueue({ path });
    const restored = second.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'a'.repeat(40), projectionKind: 'protobuf',
    });
    assert.equal(restored?.producerCheckRunId, 42);
    record(second, { projectionKind: 'dart', expiresAt: 0 });
    const pruned = second.prune({ completedBefore: 0 });
    assert.equal(pruned.contractAdmissions, 1);
    assert.equal(second.getContractAdmission({
      owner: 'O', repo: 'R', prNumber: 2, headSha: 'a'.repeat(40), projectionKind: 'dart',
    }), null);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed receipt metadata before persistence', () => {
  const queue = new SqliteQueue({ path: ':memory:' });
  try {
    assert.throws(() => queue.recordContractAdmission({}), /Invalid contract admission record/u);
    assert.throws(() => record(queue, { producerCheckRunId: 0 }), /Invalid producer check run id/u);
  } finally {
    queue.close();
  }
});
