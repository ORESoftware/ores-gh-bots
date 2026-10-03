import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  loadPolicyDocuments,
  parseDotenv,
  validatePolicyDocuments,
} from '../scripts/lib/github-app-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = await loadPolicyDocuments(root);

test('least-privilege GitHub App manifests match the machine-readable policy', () => {
  assert.deepEqual(validatePolicyDocuments(baseline), []);
});

test('permission elevation is rejected as drift', () => {
  const documents = structuredClone(baseline);
  documents.manifests.openai.default_permissions.contents = 'read';
  assert.match(validatePolicyDocuments(documents).join('\n'), /openai: permission drift/u);
});

test('webhook subscription drift is rejected', () => {
  const documents = structuredClone(baseline);
  documents.manifests.orchestrator.default_events.push('check_suite');
  assert.match(validatePolicyDocuments(documents).join('\n'), /orchestrator: event drift/u);
});

test('review identities must remain public-unlisted for fleet installation', () => {
  const documents = structuredClone(baseline);
  documents.manifests.claude.public = false;
  assert.match(validatePolicyDocuments(documents).join('\n'), /claude: public must be true/u);
});

test('Actions dispatcher stays restricted to the central repository', () => {
  const documents = structuredClone(baseline);
  documents.inventory.apps.actions.installations[0].repositories.push('ORESoftware/another-repo');
  assert.match(validatePolicyDocuments(documents).join('\n'), /actions: central-repository App must be restricted/u);
});

test('dotenv parser preserves PEM escape sequences and reports duplicate keys', () => {
  const parsed = parseDotenv('A=one\nPEM=first\\nsecond\nA=two\n');
  assert.equal(parsed.values.PEM, 'first\\nsecond');
  assert.deepEqual(parsed.duplicates, ['A']);
});
