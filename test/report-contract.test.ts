import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReportEnvelopeInvariant,
  buildReportEnvelope,
  TJSV_REVISION,
} from '../src/report-contract.ts';
import { MERGE_CONFIDENCE_THRESHOLD } from '../src/config.ts';

function report(over: Record<string, unknown> = {}) {
  return {
    startedAt: '2026-09-09T06:00:00.000Z',
    finishedAt: '2026-09-09T06:01:00.000Z',
    dryRun: false,
    reposScanned: 1,
    pullsScanned: 1,
    outcomes: [{
      repo: 'ORESoftware/example',
      number: 7,
      title: 'safe',
      action: 'merged' as const,
      reason: 'all gates passed',
      confidence: 1,
      hoursOpen: 55,
      disturbedBy: [] as string[],
    }],
    apiCalls: 12,
    ...over,
  };
}

describe('report contract', () => {
  test('publishes immutable TJSV provenance and peer-authority policy', () => {
    const envelope = buildReportEnvelope(report());
    assert.match(envelope.validator.revision, /^[0-9a-f]{40}$/u);
    assert.equal(envelope.validator.revision, TJSV_REVISION);
    assert.equal(envelope.validator.authorityModel, 'peer');
    assert.equal(envelope.policy.confidenceComparison, 'strictly-greater-than');
    assert.ok(envelope.policy.minimumConflictHistoryCommitsPerSide >= 15);
  });

  test('rejects a merge exactly at the 99.5% boundary', () => {
    const envelope = buildReportEnvelope({ ...report(), outcomes: [] });
    const bad = {
      ...envelope,
      report: {
        ...report(),
        outcomes: [{ ...report().outcomes[0], confidence: MERGE_CONFIDENCE_THRESHOLD }],
      },
    };
    assert.throws(() => assertReportEnvelopeInvariant(bad), /not strictly above/);
  });

  test('rejects a merge before 55 hours', () => {
    const envelope = buildReportEnvelope({ ...report(), outcomes: [] });
    const bad = {
      ...envelope,
      report: {
        ...report(),
        outcomes: [{ ...report().outcomes[0], hoursOpen: 54.99 }],
      },
    };
    assert.throws(() => assertReportEnvelopeInvariant(bad), /merged before 55h/);
  });

  test('rejects a merge while a dependency is disturbed', () => {
    const envelope = buildReportEnvelope({ ...report(), outcomes: [] });
    const bad = {
      ...envelope,
      report: {
        ...report(),
        outcomes: [{ ...report().outcomes[0], disturbedBy: ['zed-pkg/zed-cli'] }],
      },
    };
    assert.throws(() => assertReportEnvelopeInvariant(bad), /dependency graph was disturbed/);
  });

  test('rejects a dry-run receipt that claims a merge', () => {
    const envelope = buildReportEnvelope({ ...report(), outcomes: [] });
    const bad = { ...envelope, report: { ...report(), dryRun: true } };
    assert.throws(() => assertReportEnvelopeInvariant(bad), /dry-run report cannot claim a merge/);
  });
});
