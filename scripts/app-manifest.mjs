import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyDocuments } from './lib/github-app-policy.mjs';
import { resolveCli } from '../packages/core/src/cli.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const modulePath = fileURLToPath(import.meta.url);
const defaultStateMaxAgeMs = 2 * 60 * 60 * 1_000;

export function parseOptions(argv) {
  const cli = resolveCli([process.execPath, modulePath, ...argv], { env: {} });
  if (cli.help) return { command: cli.command, options: {}, help: cli };
  const options = {};
  const mapping = {
    role: 'ORES_APP_ROLE',
    owner: 'ORES_APP_OWNER',
    'owner-type': 'ORES_APP_OWNER_TYPE',
    'base-url': 'ORES_APP_BASE_URL',
    output: 'ORES_APP_OUTPUT',
    'state-file': 'ORES_APP_STATE_FILE',
    'code-file': 'ORES_APP_CODE_FILE',
    'callback-state-file': 'ORES_APP_CALLBACK_STATE_FILE',
  };
  for (const [option, envName] of Object.entries(mapping)) {
    if (cli.env[envName] !== undefined) options[option] = cli.env[envName];
  }
  return { command: cli.command, options, help: null };
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

function registrationAction(owner, ownerType, state) {
  if (ownerType === 'user') {
    return `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  }
  if (ownerType === 'organization') {
    return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  }
  throw new Error('--owner-type must be user or organization');
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

async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function createForm(options, {
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  log = console.log,
  loadDocuments = loadPolicyDocuments,
} = {}) {
  const role = requireOption(options, 'role');
  const owner = requireOption(options, 'owner');
  const ownerType = options['owner-type'] ?? 'user';
  const baseUrl = requireOption(options, 'base-url');
  const output = resolve(options.output ?? `/tmp/ores-gh-app-${role}.html`);
  const stateFile = resolve(options['state-file'] ?? `${output}.state.json`);
  if (output === stateFile) throw new Error('--output and --state-file must be different paths');

  const documents = await loadDocuments(root);
  const manifest = documents.manifests[role];
  if (!manifest) throw new Error(`Unknown App role: ${role}`);
  const prepared = withRuntimeUrls(manifest, baseUrl);

  const state = randomBytesImpl(32).toString('hex');
  const action = registrationAction(owner, ownerType, state);
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
  const stateRecord = {
    version: 1,
    role,
    owner,
    ownerType,
    state,
    createdAt: now().toISOString(),
  };

  await writePrivateFile(output, html);
  await writePrivateFile(stateFile, `${JSON.stringify(stateRecord, null, 2)}\n`);
  log(JSON.stringify({ role, owner, ownerType, output, stateFile }, null, 2));
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

async function readSecretInput(options, { fileOption, envName, label, env = process.env }) {
  const file = options[fileOption];
  const envValue = env[envName];
  if (file && envValue) throw new Error(`Set only one of ${envName} or --${fileOption}`);
  const value = file ? await readFile(resolve(file), 'utf8') : envValue;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Set ${envName} or pass --${fileOption} with the ${label}`);
  }
  return value.trim();
}

function stateMatches(expected, actual) {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

async function verifyCallbackState(options, role, {
  env = process.env,
  now = () => new Date(),
  maxAgeMs = defaultStateMaxAgeMs,
} = {}) {
  const stateFile = resolve(requireOption(options, 'state-file'));
  const callbackState = await readSecretInput(options, {
    fileOption: 'callback-state-file',
    envName: 'GITHUB_MANIFEST_STATE',
    label: 'callback state',
    env,
  });

  let record;
  try {
    record = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read a valid manifest state record: ${error.message}`);
  }
  if (record?.version !== 1 || record.role !== role || typeof record.state !== 'string') {
    throw new Error('Manifest state record does not match the requested App role');
  }
  const createdAtMs = Date.parse(record.createdAt);
  const ageMs = now().getTime() - createdAtMs;
  if (!Number.isFinite(createdAtMs) || ageMs < 0 || ageMs > maxAgeMs) {
    throw new Error('Manifest state record is expired or has an invalid timestamp; generate a new form');
  }
  if (!stateMatches(record.state, callbackState)) {
    throw new Error('GitHub App callback state did not match the private registration state');
  }
  return stateFile;
}

export async function convertManifest(options, {
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  now = () => new Date(),
  maxAgeMs = defaultStateMaxAgeMs,
} = {}) {
  const role = requireOption(options, 'role');
  if (Object.hasOwn(options, 'code')) {
    throw new Error('Do not pass the manifest code on the command line; use GITHUB_MANIFEST_CODE or --code-file');
  }
  if (Object.hasOwn(options, 'state')) {
    throw new Error('Do not pass callback state on the command line; use GITHUB_MANIFEST_STATE or --callback-state-file');
  }
  const mapping = credentialMap[role];
  if (!mapping) throw new Error(`Unknown App role: ${role}`);
  const stateFile = await verifyCallbackState(options, role, { env, now, maxAgeMs });
  const code = await readSecretInput(options, {
    fileOption: 'code-file',
    envName: 'GITHUB_MANIFEST_CODE',
    label: 'one-time manifest conversion code',
    env,
  });
  const output = resolve(options.output ?? `${root}/env/dec/registrations/${role}.env`);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'ores-gh-bots-manifest-bootstrap',
  };
  if (env.GITHUB_MANIFEST_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_MANIFEST_TOKEN}`;
  }
  const response = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers,
  });
  if (!response.ok) {
    const requestId = response.headers?.get?.('x-github-request-id');
    throw new Error(`Manifest conversion failed (${response.status})${requestId ? `; GitHub request ${requestId}` : ''}`);
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

  await writePrivateFile(output, lines.join('\n'));
  await unlink(stateFile);
  log(`Wrote ${output} with mode 0600 and consumed the verified state record. Secret values were not printed.`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { command, options, help } = parseOptions(argv);
  if (help) return help.printHelp();
  if (command === 'form') return createForm(options, dependencies);
  if (command === 'convert') return convertManifest(options, dependencies);
  throw new Error('Usage: node scripts/app-manifest.mjs <form|convert> --role ROLE ...');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
