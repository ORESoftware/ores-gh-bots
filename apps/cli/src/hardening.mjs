#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyOrganizationHardening,
  GitHubClient,
  validateHardeningFleet,
} from '../../../packages/github/src/index.mjs';
import { loadConfig, redactObject } from '../../../packages/core/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) positional.push(item);
    else {
      const [key, inline] = item.slice(2).split('=', 2);
      flags[key] = inline ?? (argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true);
    }
  }
  return { positional, flags };
}

function boolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function csv(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function usage() {
  console.error(`Usage:
  npm run hardening -- plan [--organization ORG[,ORG...]] [--repositories] [--ensure-repositories] [--limit N]
  npm run hardening -- apply --confirm HARDEN-<ticket> [--organization ORG[,ORG...]] [--repositories] [--ensure-repositories] [--continue]

Environment equivalents are available for workflow execution:
  HARDENING_ACTION, HARDENING_ORGANIZATIONS, HARDENING_INCLUDE_REPOSITORIES,
  HARDENING_ENSURE_REPOSITORIES, HARDENING_CONFIRMATION, HARDENING_LIMIT,
  HARDENING_MAX_REPOSITORIES, HARDENING_CONTINUE.
`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const action = positional[0] ?? process.env.HARDENING_ACTION ?? 'plan';
if (!['plan', 'apply'].includes(action)) {
  usage();
  process.exitCode = 2;
} else {
  const runtime = loadConfig();
  if (!runtime.admin.token) throw new Error('GITHUB_ADMIN_TOKEN is required for fleet hardening');
  const path = resolve(root, String(flags.config ?? process.env.HARDENING_CONFIG ?? 'config/hardening-fleet.v1.json'));
  const fleet = validateHardeningFleet(JSON.parse(await readFile(path, 'utf8')));
  const requested = new Set(csv(flags.organization ?? process.env.HARDENING_ORGANIZATIONS).map((item) => item.toLowerCase()));
  const limit = Number(flags.limit ?? process.env.HARDENING_LIMIT ?? fleet.organizations.length);
  const includeRepositories = boolean(flags.repositories ?? process.env.HARDENING_INCLUDE_REPOSITORIES, false);
  const ensureRepositories = boolean(flags['ensure-repositories'] ?? process.env.HARDENING_ENSURE_REPOSITORIES, false);
  const continueOnError = boolean(flags.continue ?? process.env.HARDENING_CONTINUE, false);
  const maxRepositories = Number(flags['max-repositories'] ?? process.env.HARDENING_MAX_REPOSITORIES ?? 10_000);
  const confirmation = String(flags.confirm ?? process.env.HARDENING_CONFIRMATION ?? '');
  if (action === 'apply' && !confirmation.startsWith('HARDEN-')) {
    throw new Error('Apply requires --confirm HARDEN-<change-ticket>');
  }

  let organizations = fleet.organizations.filter((organization) => requested.size === 0 || requested.has(organization.name.toLowerCase()));
  organizations = organizations
    .sort((a, b) => (a.environment === 'test' ? 0 : 1) - (b.environment === 'test' ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
  if (requested.size > 0 && organizations.length !== requested.size) {
    const found = new Set(organizations.map((organization) => organization.name.toLowerCase()));
    const missing = [...requested].filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Unknown organizations: ${missing.join(', ')}`);
  }

  const client = new GitHubClient({ apiBaseUrl: runtime.github.apiBaseUrl, apiVersion: runtime.github.apiVersion });
  const results = [];
  for (const organization of organizations) {
    try {
      results.push({
        organization: organization.name,
        environment: organization.environment,
        changes: await applyOrganizationHardening(client, runtime.admin.token, fleet, organization, {
          dryRun: action === 'plan',
          ensureRepositories,
          includeRepositories,
          maxRepositories,
          continueOnError,
        }),
      });
    } catch (error) {
      results.push({ organization: organization.name, error: error.message, status: error.status ?? null });
      if (!continueOnError) break;
    }
  }
  console.log(JSON.stringify(redactObject({
    action,
    organization_count: organizations.length,
    include_repositories: includeRepositories,
    ensure_repositories: ensureRepositories,
    results,
  }), null, 2));
}
