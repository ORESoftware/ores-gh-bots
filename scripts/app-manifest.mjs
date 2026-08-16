import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyDocuments } from './lib/github-app-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function parseOptions(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const key = flag.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function registrationAction(owner, state) {
  return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

function withRuntimeUrls(manifest, baseUrl) {
  const result = structuredClone(manifest);
  if (!result.hook_attributes && !result.redirect_url) return result;
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('--base-url must use HTTPS');
  const prefix = base.toString().replace(/\/$/u, '');
  if (result.hook_attributes) result.hook_attributes.url = `${prefix}/webhooks/github`;
  if (result.redirect_url) result.redirect_url = `${prefix}/github/app-manifest/callback`;
  return result;
}

async function createForm(options) {
  const role = requireOption(options, 'role');
  const owner = requireOption(options, 'owner');
  const output = resolve(options.output ?? `/tmp/ores-gh-app-${role}.html`);
  const documents = await loadPolicyDocuments(root);
  const manifest = documents.manifests[role];
  if (!manifest) throw new Error(`Unknown App role: ${role}`);
  const prepared = withRuntimeUrls(manifest, options['base-url'] ?? 'https://replace.example');
  if (role === 'orchestrator' && !options['base-url']) {
    throw new Error('The orchestrator form requires --base-url for its webhook and redirect URLs');
  }

  const state = randomBytes(32).toString('hex');
  const action = registrationAction(owner, state);
  const manifestJson = JSON.stringify(prepared);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>Register ${escapeHtml(prepared.name)}</title>
</head>
<body>
  <h1>Register ${escapeHtml(prepared.name)}</h1>
  <p>Review the permissions on GitHub before creating the App.</p>
  <form action="${escapeHtml(action)}" method="post">
    <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
    <button type="submit">Create GitHub App</button>
  </form>
</body>
</html>
`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html, { mode: 0o600 });
  await chmod(output, 0o600);
  console.log(JSON.stringify({ role, owner, output, state }, null, 2));
}

const credentialMap = {
  orchestrator: {
    id: 'GITHUB_APP_ID',
    pem: 'GITHUB_APP_PRIVATE_KEY',
    webhook: 'GITHUB_WEBHOOK_SECRET',
  },
  openai: {
    id: 'OPENAI_REVIEW_APP_ID',
    pem: 'OPENAI_REVIEW_APP_PRIVATE_KEY',
  },
  claude: {
    id: 'CLAUDE_REVIEW_APP_ID',
    pem: 'CLAUDE_REVIEW_APP_PRIVATE_KEY',
  },
  gate: {
    id: 'GATE_APP_ID',
    pem: 'GATE_APP_PRIVATE_KEY',
  },
  actions: {
    id: 'ACTIONS_APP_ID',
    pem: 'ACTIONS_APP_PRIVATE_KEY',
  },
};

function dotenvValue(value) {
  return String(value).replace(/\r?\n/gu, '\\n');
}

async function convertManifest(options) {
  const role = requireOption(options, 'role');
  const code = requireOption(options, 'code');
  const mapping = credentialMap[role];
  if (!mapping) throw new Error(`Unknown App role: ${role}`);
  const output = resolve(options.output ?? `${root}/env/dec/registrations/${role}.env`);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'ores-gh-bots-manifest-bootstrap',
  };
  if (process.env.GITHUB_MANIFEST_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_MANIFEST_TOKEN}`;
  }
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers,
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(`Manifest conversion failed (${response.status}): ${body}`);
  }
  const result = await response.json();
  if (!Number.isSafeInteger(result.id) || result.id <= 0 || typeof result.pem !== 'string' || !result.pem.includes('PRIVATE KEY')) {
    throw new Error('Manifest conversion response did not contain the expected App ID and private key');
  }
  if (mapping.webhook && (typeof result.webhook_secret !== 'string' || !result.webhook_secret)) {
    throw new Error('Manifest conversion response did not contain the orchestrator webhook secret');
  }

  const lines = [
    `# Generated for role=${role}; app_slug=${result.slug ?? 'unknown'}`,
    `${mapping.id}=${result.id}`,
    `${mapping.pem}=${dotenvValue(result.pem)}`,
  ];
  if (mapping.webhook) lines.push(`${mapping.webhook}=${dotenvValue(result.webhook_secret)}`);
  lines.push('');

  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, lines.join('\n'), { mode: 0o600 });
  await chmod(output, 0o600);
  console.log(`Wrote ${output} with mode 0600. Secret values were not printed.`);
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command === 'form') return createForm(options);
  if (command === 'convert') return convertManifest(options);
  throw new Error('Usage: node scripts/app-manifest.mjs <form|convert> --role ROLE ...');
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
