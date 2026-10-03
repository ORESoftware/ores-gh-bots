import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyDocuments, parseDotenv } from './lib/github-app-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(process.argv[2] ?? `${root}/env/dec/review-bots.env`);
const { policy, secretInventory } = await loadPolicyDocuments(root);
const { values, duplicates } = parseDotenv(await readFile(target, 'utf8'));
const errors = duplicates.map((key) => `duplicate key ${key}`);

function isPlaceholder(value) {
  return !value || /^(?:replace(?:-with|-me)?|example|changeme|<)/iu.test(value);
}

for (const key of secretInventory.requiredKeys) {
  const value = values[key];
  if (isPlaceholder(value)) errors.push(`${key} is missing or still a placeholder`);
}

const appIdKeys = Object.values(policy.apps).flatMap((entry) => entry.secretEnv).filter((key) => key.endsWith('_APP_ID') || key === 'GITHUB_APP_ID');
const appIds = [];
for (const key of appIdKeys) {
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${key} must be a positive integer`);
  else appIds.push([key, value]);
}
const duplicateIds = appIds.filter(([, id], index) => appIds.findIndex(([, other]) => other === id) !== index);
for (const [key] of duplicateIds) errors.push(`${key} must identify a distinct GitHub App`);

const privateKeyKeys = Object.values(policy.apps).flatMap((entry) => entry.secretEnv).filter((key) => key.includes('PRIVATE_KEY'));
for (const key of privateKeyKeys) {
  const normalized = String(values[key] ?? '').replaceAll('\\n', '\n');
  if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\n/u.test(normalized)) {
    errors.push(`${key} must contain a PEM private key; literal \\n separators are supported`);
  }
}

if (String(values.GITHUB_WEBHOOK_SECRET ?? '').length < 20) errors.push('GITHUB_WEBHOOK_SECRET must be at least 20 characters');

if (errors.length > 0) {
  console.error(`secret validation failed for ${target}:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`secret validation: ok (${secretInventory.requiredKeys.length} required keys)`);
