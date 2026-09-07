export const CONTRACT_PROJECTION_ADMISSION_SCHEMA =
  'ores.gh-bots.contract-projection-admission/v1';
export const CONTRACT_PROJECTION_ADMISSION_VERIFICATION_SCHEMA =
  'ores.gh-bots.contract-projection-admission-verification/v1';

export const REPORT_SCHEMA = 'ores.typespec-json-schema-validator.report/v1';
export const CONTRACT_IR_SCHEMA = 'ores.typespec-json-schema-validator.contract-ir/v1';
export const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const HEX_160 = /^[a-f0-9]{40}$/u;
export const HEX_256 = /^[a-f0-9]{64}$/u;
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
export const SET_LIKE_ARRAY_KEYS = new Set([
  'allOf',
  'anyOf',
  'enum',
  'oneOf',
  'required',
  'type',
]);
export const PROJECTION_KINDS = new Set([
  'asyncapi',
  'connect',
  'dart',
  'diesel',
  'drizzle',
  'fixtures',
  'gleam',
  'go',
  'grpc',
  'json-rpc',
  'mocks',
  'openapi',
  'openrpc',
  'protobuf',
  'seaorm',
  'serde',
  'sql',
  'trpc',
  'wasm',
  'wit',
  'zod',
]);
export const FIELD_LOCK_KINDS = new Set(['connect', 'grpc', 'protobuf']);
export const OPERATION_INVENTORY_KINDS = new Set([
  'asyncapi',
  'connect',
  'grpc',
  'json-rpc',
  'openapi',
  'openrpc',
  'trpc',
]);
