import { fileURLToPath } from 'node:url';
import { assertFleetHardeningDocuments } from './lib/fleet-hardening-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

try {
  const result = await assertFleetHardeningDocuments(root);
  console.log(`fleet-hardening-policy: ok (${result.apiVersion}, ${result.policyVersion})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
