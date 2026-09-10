import "@typespec/json-schema";
using TypeSpec.JsonSchema;

// Independent human-authored TypeSpec authority. Never generate this file from
// authored.schema.json; TJSV compares the two peer authorities fail closed.
@jsonSchema
namespace Den3946PrReconcile;

@extension("additionalProperties", false)
model ValidatorEvidence {
  repository: "ORESoftware/typespec-json-schema-validator";
  @pattern("^[0-9a-f]{40}$") revision: string;
  authorityModel: "peer";
  typespecHumanAuthored: true;
  jsonSchemaHumanAuthored: true;
}

@extension("additionalProperties", false)
model PolicyEvidence {
  @minValue(55) minimumOpenHours: integer;
  @minValue(0) @maxValue(1000000) confidenceThresholdPpm: integer;
  confidenceComparison: "strictly-greater-than";
  @minValue(15) minimumConflictHistoryCommitsPerSide: integer;
}

@extension("additionalProperties", false)
model PullOutcome {
  @minLength(3) repo: string;
  @minValue(1) number: integer;
  @minLength(1) title: string;
  action: "merged" | "updated" | "escalated" | "held" | "skipped" | "failed";
  reason: string;
  @minValue(0) @maxValue(1) confidence: float64;
  @minValue(0) hoursOpen: float64;
  disturbedBy: string[];
}

@extension("additionalProperties", false)
model ReconcileReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  @minValue(0) reposScanned: integer;
  @minValue(0) pullsScanned: integer;
  outcomes: PullOutcome[];
  @minValue(0) apiCalls: integer;
}

@extension("additionalProperties", false)
model PrReconcileEnvelope {
  schema: "ores.pr-reconcile-report/v1";
  trackingIssue: "DEN-3946";
  validator: ValidatorEvidence;
  policy: PolicyEvidence;
  report: ReconcileReport;
}
