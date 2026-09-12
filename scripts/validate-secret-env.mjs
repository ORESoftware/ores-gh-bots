import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyDocuments, parseDotenv } from './lib/github-app-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(process.argv[2] ?? `${root}/env/dec/review-bots.env`);
const { policy, secretInventory } = await loadPolicyDocuments(root);
const { values, duplicates } = parseDotenv(await readFile(target, 'utf8'));

function isPlaceholder(value) {
  return !value || /^(?:replace(?:-with|-me)?|example|changeme|<)/iu.test(value);
}

const secretEnvKeys = Object.values(policy.apps).flatMap((entry) => entry.secretEnv);
const appIdKeys = secretEnvKeys.filter((key) => key.endsWith('_APP_ID') || key === 'GITHUB_APP_ID');
const privateKeyKeys = secretEnvKeys.filter((key) => key.includes('PRIVATE_KEY'));
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const appIds = appIdKeys.map((key) => [key, Number(values[key])]).filter(([, id]) => isPositiveInteger(id));
const duplicateIds = appIds.filter(([, id], index) => appIds.findIndex(([, other]) => other === id) !== index);
const pemHeader = /^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\n/u;

// Every check is a list of messages; the report is their concatenation in check order.
const errors = [
  ...duplicates.map((key) => `duplicate key ${key}`),
  ...secretInventory.requiredKeys.filter((key) => isPlaceholder(values[key])).map((key) => `${key} is missing or still a placeholder`),
  ...appIdKeys.filter((key) => !isPositiveInteger(Number(values[key]))).map((key) => `${key} must be a positive integer`),
  ...duplicateIds.map(([key]) => `${key} must identify a distinct GitHub App`),
  ...privateKeyKeys
    .filter((key) => !pemHeader.test(String(values[key] ?? '').replaceAll('\\n', '\n')))
    .map((key) => `${key} must contain a PEM private key; literal \\n separators are supported`),
  ...(String(values.GITHUB_WEBHOOK_SECRET ?? '').length < 20 ? ['GITHUB_WEBHOOK_SECRET must be at least 20 characters'] : []),
];

if (errors.length > 0) {
  console.error(`secret validation failed for ${target}:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`secret validation: ok (${secretInventory.requiredKeys.length} required keys)`);
