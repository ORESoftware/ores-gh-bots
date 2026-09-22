#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppAuth,
  applyFleetHardeningPlan,
  buildFleetHardeningPlan,
  fleetHardeningPlanDigest,
  GitHubClient,
  listAppInstallations,
  validateFleetHardeningCanaryReceipt,
  validateFleetHardeningPlan,
  validateHardeningFleet,
} from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  ownerIsAllowed,
  resolveCli,
} from '../../../packages/core/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const modulePath = fileURLToPath(import.meta.url);
const IMPLEMENTATION_FILES = [
  '.cli-flags.toml',
  'apps/cli/src/hardening.mjs',
  'config/hardening-fleet.schema.json',
  'packages/github/src/fleet-hardening-plan.mjs',
  'packages/github/src/fleet-hardening-plan-admission.mjs',
  'packages/github/src/hardening.mjs',
];
const SHA = /^[0-9a-f]{40}$/u;

function normalizePrivateKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('base64:')) return Buffer.from(text.slice(7), 'base64').toString('utf8');
  return text.replace(/\\n/gu, '\n');
}

function hardeningCredentials(env) {
  return Object.freeze({
    id: String(env.FLEET_HARDENING_APP_ID ?? '').trim() || null,
    privateKey: normalizePrivateKey(env.FLEET_HARDENING_APP_PRIVATE_KEY),
  });
}

async function implementationDigest() {
  const hash = createHash('sha256');
  for (const path of [...IMPLEMENTATION_FILES].sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(root, path)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function requireEnvironment(value) {
  const environment = String(value ?? '').trim();
  if (!['test', 'production'].includes(environment)) throw new Error('--environment must be test or production');
  return environment;
}

function requireReviewedPath(value, directory, label) {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('/') || text.includes('\\')) throw new Error(`${label} must be a reviewed relative path`);
  const base = resolve(root, directory);
  const absolute = resolve(root, text);
  const rel = relative(base, absolute);
  if (!rel || rel.startsWith('..') || rel.split('/').includes('..')) {
    throw new Error(`${label} must be under ${directory}/`);
  }
  return absolute;
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return parsed;
}

async function installationTokenForOrganization({ client, auth, organization }) {
  const installations = await listAppInstallations(client, auth.appJwt('hardening'));
  const matches = installations.filter((installation) => (
    String(installation.account?.login ?? '').toLowerCase() === organization.toLowerCase()
  ));
  if (matches.length !== 1) throw new Error(`Expected exactly one fleet-hardening App installation for ${organization}`);
  return auth.installationToken('hardening', matches[0].id);
}

async function main() {
  const cli = resolveCli();
  if (cli.help) return cli.printHelp();
  if (!['hardening plan', 'hardening apply'].includes(cli.command)) {
    throw new Error('Usage: hardening plan|apply through the canonical .cli-flags.toml contract');
  }

  const action = cli.command.split(' ')[1];
  const organization = String(cli.values.HARDENING_ORGANIZATION ?? '').trim();
  if (!organization) throw new Error('Exactly one explicit --organization is required');
  const expectedEnvironment = requireEnvironment(cli.values.HARDENING_EXPECTED_ENVIRONMENT);
  const runtime = loadConfig(cli.env);
  if (runtime.github.ownerAllowlist.length === 0 && runtime.github.ownerPatterns.length === 0) {
    throw new Error('OWNER_ALLOWLIST or OWNER_PATTERNS is required');
  }
  if (!ownerIsAllowed(runtime, organization)) throw new Error(`Organization ${organization} is outside the runtime owner policy`);

  const credentials = hardeningCredentials(cli.env);
  if (!credentials.id || !credentials.privateKey) {
    throw new Error('FLEET_HARDENING_APP_ID and FLEET_HARDENING_APP_PRIVATE_KEY are required');
  }
  const configPath = resolve(root, String(cli.values.HARDENING_CONFIG));
  const fleet = validateHardeningFleet(await readJson(configPath, 'Fleet hardening config'));
  const implementation = await implementationDigest();
  const logger = createLogger({ service: 'ores-gh-bots-fleet-hardening' });
  const client = new GitHubClient({ apiBaseUrl: runtime.github.apiBaseUrl, apiVersion: runtime.github.apiVersion });
  const auth = new AppAuth({ client, apps: { ...runtime.apps, hardening: credentials }, logger });
  const outputPath = resolve(root, String(cli.values.HARDENING_OUTPUT));

  if (action === 'plan') {
    const sourceRevision = String(cli.env.HARDENING_SOURCE_REVISION ?? cli.env.GITHUB_SHA ?? '').toLowerCase();
    if (!SHA.test(sourceRevision)) throw new Error('Plan mode requires HARDENING_SOURCE_REVISION or GITHUB_SHA as 40 lowercase hex');
    const token = await installationTokenForOrganization({ client, auth, organization });
    const plan = await buildFleetHardeningPlan(client, token, fleet, {
      organizationName: organization,
      expectedEnvironment,
      includeRepositories: Boolean(cli.values.HARDENING_INCLUDE_REPOSITORIES),
      maxRepositories: Number(cli.values.HARDENING_MAX_REPOSITORIES),
      sourceRevision,
      implementationDigest: implementation,
    });
    const digest = fleetHardeningPlanDigest(plan);
    await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({
      action: 'plan',
      organization: plan.organization,
      environment: plan.environment,
      operation_count: plan.operation_count,
      plan_digest: digest,
      output: String(cli.values.HARDENING_OUTPUT),
    }, null, 2));
    return;
  }

  const planPath = requireReviewedPath(cli.values.HARDENING_PLAN_PATH, 'plans/fleet-hardening', 'Plan');
  const plan = await readJson(planPath, 'Fleet hardening plan');
  if (String(plan.organization ?? '').toLowerCase() !== organization.toLowerCase()) {
    throw new Error('Reviewed plan organization does not match --organization');
  }
  const validated = validateFleetHardeningPlan(plan, {
    expectedDigest: String(cli.values.HARDENING_PLAN_DIGEST ?? ''),
    fleet,
    implementationDigest: implementation,
    expectedEnvironment,
  });

  if (expectedEnvironment === 'production') {
    const receiptPath = requireReviewedPath(
      cli.values.HARDENING_CANARY_RECEIPT_PATH,
      'receipts/fleet-hardening',
      'Canary receipt',
    );
    const receipt = await readJson(receiptPath, 'Fleet hardening canary receipt');
    validateFleetHardeningCanaryReceipt(receipt, {
      expectedDigest: String(cli.values.HARDENING_CANARY_DIGEST ?? ''),
      fleet,
      productionOrganization: organization,
    });
  }

  const result = await applyFleetHardeningPlan(
    client,
    async (owner, repo) => (await auth.repoToken('hardening', owner, repo)).token,
    validated,
    {
      planDigest: String(cli.values.HARDENING_PLAN_DIGEST),
      changeTicket: String(cli.values.HARDENING_CONFIRMATION ?? ''),
    },
  );
  const ledger = {
    schema: 'ores.fleet-hardening-apply-ledger.v1',
    organization,
    environment: expectedEnvironment,
    plan_digest: String(cli.values.HARDENING_PLAN_DIGEST),
    ok: result.ok,
    proposals: result.ledger,
  };
  await writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({
    action: 'apply',
    organization,
    environment: expectedEnvironment,
    plan_digest: ledger.plan_digest,
    ok: ledger.ok,
    proposal_count: ledger.proposals.length,
    output: String(cli.values.HARDENING_OUTPUT),
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  try {
    await main();
  } catch (error) {
    console.error(String(error?.message ?? 'fleet hardening failed'));
    process.exitCode = 1;
  }
}
