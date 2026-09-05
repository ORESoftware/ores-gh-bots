import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  loadFleetHardeningDocuments,
  validateFleetHardeningDocuments,
} from '../scripts/lib/fleet-hardening-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = await loadFleetHardeningDocuments(root);

test('canonical fleet-hardening policy and schema remain in exact parity', () => {
  assert.deepEqual(validateFleetHardeningDocuments(baseline), []);
});

test('policy rejects undeclared extensions instead of silently widening scope', () => {
  const documents = structuredClone(baseline);
  documents.policy.spec.repository.allow_unknown_bindings = true;
  assert.match(validateFleetHardeningDocuments(documents).join('\n'), /expected exactly keys/u);
});

test('policy preserves Diesel code-first and SeaORM database-first direction', () => {
  const documents = structuredClone(baseline);
  documents.policy.spec.sql.diesel_model = 'database-first';
  documents.policy.spec.sql.seaorm_model = 'code-first';
  const errors = validateFleetHardeningDocuments(documents).join('\n');
  assert.match(errors, /diesel_model/u);
  assert.match(errors, /seaorm_model/u);
});

test('schema cannot make a required policy field optional', () => {
  const documents = structuredClone(baseline);
  documents.schema.properties.spec.properties.supply_chain.required = ['source_revision_required'];
  assert.match(validateFleetHardeningDocuments(documents).join('\n'), /required keys must match/u);
});

test('schema cannot permit undeclared properties', () => {
  const documents = structuredClone(baseline);
  documents.schema.properties.spec.additionalProperties = true;
  assert.match(validateFleetHardeningDocuments(documents).join('\n'), /reject additional properties/u);
});
