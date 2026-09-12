import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fleetHardeningPolicyV1 = {
  $schema: './hardening-fleet.v1.schema.json',
  api_version: 'ores.dev/fleet-hardening/v1',
  kind: 'FleetHardeningPolicy',
  metadata: {
    name: 'ores-fleet-hardening',
    version: '1.0.0',
  },
  spec: {
    sql: {
      authority: 'organization-local-with-central-mirror',
      namespace_pattern: '^[a-z][a-z0-9_]{0,62}$',
      migration_registry: 'declarative-migrations/declarative-postgres-migrate.rs',
      diesel_model: 'code-first',
      seaorm_model: 'database-first',
    },
    kubernetes: {
      cluster_repository: 'ORESoftware/k8s-cluster',
      shared_library_repository: 'ORESoftware/k8s-libs-and-shared-defs',
      deployment_model: 'gitops',
    },
    repository: {
      binding_path: '.ores/repository-hardening.v1.json',
      fail_closed: true,
    },
    supply_chain: {
      source_revision_required: true,
      content_sha256_required: true,
    },
  },
};

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateExactValue(actual, expected, path, errors) {
  if (expected === null || typeof expected !== 'object') {
    if (actual !== expected) errors.push(`${path}: expected ${JSON.stringify(expected)}`);
    return;
  }

  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    errors.push(`${path}: expected an object`);
    return;
  }

  const expectedKeys = sortedKeys(expected);
  const actualKeys = sortedKeys(actual);
  if (!sameStrings(actualKeys, expectedKeys)) {
    errors.push(`${path}: expected exactly keys ${expectedKeys.join(', ')}`);
  }

  for (const key of expectedKeys) {
    validateExactValue(actual[key], expected[key], `${path}.${key}`, errors);
  }
}

function validateSchemaNode(schemaNode, expected, path, errors) {
  if (expected === null || typeof expected !== 'object') {
    if (schemaNode?.const !== expected) {
      errors.push(`${path}: schema const must be ${JSON.stringify(expected)}`);
    }
    return;
  }

  const expectedKeys = sortedKeys(expected);
  if (schemaNode?.type !== 'object') errors.push(`${path}: schema type must be object`);
  if (schemaNode?.additionalProperties !== false) errors.push(`${path}: schema must reject additional properties`);
  if (!Array.isArray(schemaNode?.required) || !sameStrings(schemaNode.required, expectedKeys)) {
    errors.push(`${path}: schema required keys must match the policy`);
  }
  if (!schemaNode?.properties || typeof schemaNode.properties !== 'object') {
    errors.push(`${path}: schema properties are required`);
    return;
  }
  if (!sameStrings(sortedKeys(schemaNode.properties), expectedKeys)) {
    errors.push(`${path}: schema properties must match the policy`);
  }

  for (const key of expectedKeys) {
    validateSchemaNode(schemaNode.properties[key], expected[key], `${path}.${key}`, errors);
  }
}

export function validateFleetHardeningDocuments({ policy, schema }) {
  const errors = [];
  validateExactValue(policy, fleetHardeningPolicyV1, 'policy', errors);

  if (schema?.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    errors.push('schema: must use JSON Schema draft 2020-12');
  }
  if (schema?.$id !== 'https://github.com/ORESoftware/ores-gh-bots/blob/main/config/hardening-fleet.v1.schema.json') {
    errors.push('schema: unexpected canonical $id');
  }
  validateSchemaNode(schema, fleetHardeningPolicyV1, 'schema', errors);
  return errors;
}

export async function loadFleetHardeningDocuments(root) {
  const policy = JSON.parse(await readFile(join(root, 'config/hardening-fleet.v1.json'), 'utf8'));
  const schema = JSON.parse(await readFile(join(root, 'config/hardening-fleet.v1.schema.json'), 'utf8'));
  return { policy, schema };
}

export async function assertFleetHardeningDocuments(root) {
  const documents = await loadFleetHardeningDocuments(root);
  const errors = validateFleetHardeningDocuments(documents);
  if (errors.length > 0) {
    throw new Error(`Fleet-hardening policy validation failed:\n- ${errors.join('\n- ')}`);
  }
  return {
    apiVersion: documents.policy.api_version,
    policyVersion: documents.policy.metadata.version,
  };
}
