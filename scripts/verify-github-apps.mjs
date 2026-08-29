import { fileURLToPath } from 'node:url';
import { assertPolicyDocuments } from './lib/github-app-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

try {
  const result = await assertPolicyDocuments(root);
  console.log(`github-app-policy: ok (${result.roles} roles, ${result.manifests} manifests, ${result.requiredSecrets} required secrets)`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
