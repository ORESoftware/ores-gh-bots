import {
  CONFLICT_CONTEXT_COMMITS_MIN,
  MERGE_CONFIDENCE_THRESHOLD,
  MIN_OPEN_HOURS,
} from './config.ts';
import type { ReconcileReport } from './reconcile.ts';

export const REPORT_SCHEMA = 'ores.pr-reconcile-report/v1' as const;
export const TRACKING_ISSUE = 'DEN-3946' as const;
export const TJSV_REPOSITORY = 'ORESoftware/typespec-json-schema-validator' as const;
export const TJSV_REVISION = '4a5d049218adc2740d4cf78f612caf7f38f6f64c' as const;

export interface ValidatorEvidence {
  readonly repository: typeof TJSV_REPOSITORY;
  readonly revision: string;
  readonly authorityModel: 'peer';
  readonly typespecHumanAuthored: true;
  readonly jsonSchemaHumanAuthored: true;
}

export interface PolicyEvidence {
  readonly minimumOpenHours: number;
  readonly confidenceThresholdPpm: number;
  readonly confidenceComparison: 'strictly-greater-than';
  readonly minimumConflictHistoryCommitsPerSide: number;
}

export interface PrReconcileEnvelope {
  readonly schema: typeof REPORT_SCHEMA;
  readonly trackingIssue: typeof TRACKING_ISSUE;
  readonly validator: ValidatorEvidence;
  readonly policy: PolicyEvidence;
  readonly report: ReconcileReport;
}

export function buildReportEnvelope(report: ReconcileReport): PrReconcileEnvelope {
  const envelope: PrReconcileEnvelope = {
    schema: REPORT_SCHEMA,
    trackingIssue: TRACKING_ISSUE,
    validator: {
      repository: TJSV_REPOSITORY,
      revision: TJSV_REVISION,
      authorityModel: 'peer',
      typespecHumanAuthored: true,
      jsonSchemaHumanAuthored: true,
    },
    policy: {
      minimumOpenHours: MIN_OPEN_HOURS,
      confidenceThresholdPpm: Math.round(MERGE_CONFIDENCE_THRESHOLD * 1_000_000),
      confidenceComparison: 'strictly-greater-than',
      minimumConflictHistoryCommitsPerSide: CONFLICT_CONTEXT_COMMITS_MIN,
    },
    report,
  };
  assertReportEnvelopeInvariant(envelope);
  return envelope;
}

/**
 * Fail closed before publishing a machine-readable receipt. TJSV owns the
 * cross-runtime structural parity; these checks own cross-field policy facts
 * that schema parity alone cannot express.
 */
export function assertReportEnvelopeInvariant(envelope: PrReconcileEnvelope): void {
  if (envelope.schema !== REPORT_SCHEMA) throw new Error(`unexpected report schema: ${envelope.schema}`);
  if (envelope.trackingIssue !== TRACKING_ISSUE) throw new Error(`unexpected tracking issue: ${envelope.trackingIssue}`);
  if (envelope.validator.repository !== TJSV_REPOSITORY) throw new Error('unexpected TJSV repository');
  if (!/^[0-9a-f]{40}$/u.test(envelope.validator.revision)) throw new Error('TJSV revision must be an immutable 40-hex SHA');
  if (envelope.validator.authorityModel !== 'peer' || !envelope.validator.typespecHumanAuthored || !envelope.validator.jsonSchemaHumanAuthored) {
    throw new Error('TypeSpec and JSON Schema must remain independently human-authored peer authorities');
  }
  if (envelope.policy.minimumOpenHours !== MIN_OPEN_HOURS) throw new Error('soak policy drift');
  if (envelope.policy.confidenceThresholdPpm !== Math.round(MERGE_CONFIDENCE_THRESHOLD * 1_000_000)) throw new Error('confidence threshold drift');
  if (envelope.policy.confidenceComparison !== 'strictly-greater-than') throw new Error('confidence comparison must remain exclusive');
  if (envelope.policy.minimumConflictHistoryCommitsPerSide < 15) throw new Error('semantic merge history floor regressed below 15 commits');

  for (const outcome of envelope.report.outcomes) {
    if (outcome.action !== 'merged') continue;
    if (envelope.report.dryRun) throw new Error(`${outcome.repo}#${outcome.number}: dry-run report cannot claim a merge`);
    if (outcome.hoursOpen < MIN_OPEN_HOURS) throw new Error(`${outcome.repo}#${outcome.number}: merged before ${MIN_OPEN_HOURS}h`);
    if (!(outcome.confidence > MERGE_CONFIDENCE_THRESHOLD)) throw new Error(`${outcome.repo}#${outcome.number}: merge confidence was not strictly above threshold`);
    if (outcome.disturbedBy.length !== 0) throw new Error(`${outcome.repo}#${outcome.number}: merged while dependency graph was disturbed`);
  }
}
