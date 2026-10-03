import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const recipient = process.argv[2] ?? '';
if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{50,}$/u.test(recipient)) {
  console.error('Usage: node scripts/set-sops-age-recipient.mjs age1...');
  process.exit(2);
}

const path = fileURLToPath(new URL('../.sops.yaml', import.meta.url));
const current = await readFile(path, 'utf8');
const next = current.replace(/^(\s*-\s+)age1\S+\s*$/mu, `$1${recipient}`);
if (next === current) {
  console.error('No Age recipient placeholder was found in .sops.yaml');
  process.exit(1);
}
await writeFile(path, next, { mode: 0o644 });
console.log('Updated the public Age recipient in .sops.yaml. Review and commit this non-secret key.');
