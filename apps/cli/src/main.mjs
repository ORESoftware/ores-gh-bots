#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppAuth,
  buildReviewerQueue,
  buildRulesetPayload,
  GitHubClient,
  listAppInstallations,
  listInstallationRepositories,
  REVIEWER_HINTS_MAX_BYTES,
  upsertRepositoryRuleset,
} from '../../../packages/github/src/index.mjs';
import { createLogger, loadConfig, ownerIsAllowed, redactObject, validateRuntimeConfig, verifyCanaryEvidence } from '../../../packages/core/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_CANARY_EVIDENCE_BYTES = 1_000_000;

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

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

async function readBoundedJson(path, maxBytes) {
  const content = await readFile(path);
  if (content.length > maxBytes) throw new Error(`JSON input exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('JSON input is not valid JSON');
  }
}

async function discover({ config, client, auth, limit = Infinity }) {
  const results = [];
  const installations = await listAppInstallations(client, auth.appJwt('orchestrator'));
  for (const installation of installations) {
    const token = await auth.installationToken('orchestrator', installation.id);
    const repositories = await listInstallationRepositories(client, token, Number.isFinite(limit) ? limit - results.length : 10_000);
    for (const repository of repositories) {
      if (!ownerIsAllowed(config, repository.owner?.login) || repository.archived || repository.disabled) continue;
      results.push({
        installation_id: installation.id,
        owner: repository.owner.login,
        repo: repository.name,
        full_name: repository.full_name,
        default_branch: repository.default_branch,
        private: repository.private,
      });
      if (results.length >= limit) return results;
    }
  }
  return results.sort((a, b) => {
    const aTest = /-test$/i.test(a.owner) ? 0 : 1;
    const bTest = /-test$/i.test(b.owner) ? 0 : 1;
    return aTest - bTest || a.full_name.localeCompare(b.full_name);
  });
}

function usage() {
  console.error(`Usage:
  npm run cli -- manifest print ROLE
  npm run cli -- fleet discover [--limit N]
  npm run cli -- rulesets plan|apply [--repository OWNER/REPO] [--enforcement disabled|evaluate|active] [--branch-mode all|protected] [--limit N]
  npm run cli -- canary verify --evidence PATH [--expected-digest SHA256]
  npm run cli -- reviewer plan [--reviewer LOGIN] [--limit N] [--hints PATH]
`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [group, action, subject] = positional;
const config = loadConfig();
const logger = createLogger({ service: 'ores-gh-bots-cli' });

if (group === 'manifest' && action === 'print') {
  const role = subject ?? 'orchestrator';
  const allowed = new Set(['orchestrator', 'openai-reviewer', 'claude-reviewer', 'gate-reviewer', 'actions-dispatcher']);
  if (!allowed.has(role)) throw new Error(`Unknown manifest role: ${role}`);
  console.log(await readFile(resolve(root, `github-apps/${role}.manifest.json`), 'utf8'));
} else if (group === 'fleet' && action === 'discover') {
  validateRuntimeConfig(config, { webhook: false, providers: false });
  const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
  const auth = new AppAuth({ client, apps: config.apps, logger });
  const repositories = await discover({ config, client, auth, limit: Number(flags.limit ?? config.reconciliation.maxRepos) });
  console.log(JSON.stringify({ count: repositories.length, repositories }, null, 2));
} else if (group === 'rulesets' && ['plan', 'apply'].includes(action)) {
  if (!flags.repository) validateRuntimeConfig(config, { webhook: false, providers: false });
  if (!config.admin.token) throw new Error('GITHUB_ADMIN_TOKEN is required for ruleset planning/application');
  const fleetConfig = await readJson(config.admin.fleetConfigPath);
  const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
  const auth = new AppAuth({ client, apps: config.apps, logger });
  const repositories = flags.repository
    ? [{ full_name: String(flags.repository), owner: String(flags.repository).split('/')[0], repo: String(flags.repository).split('/')[1] }]
    : await discover({ config, client, auth, limit: Number(flags.limit ?? config.reconciliation.maxRepos) });
  const enforcement = String(flags.enforcement ?? (action === 'apply' ? 'evaluate' : 'evaluate'));
  if (action === 'apply' && enforcement === 'active' && !String(flags.confirm ?? '').startsWith('ACTIVATE-')) {
    throw new Error('Active enforcement requires --confirm ACTIVATE-<change-ticket>');
  }
  const payload = buildRulesetPayload({
    enforcement,
    branchMode: String(flags['branch-mode'] ?? 'protected'),
    protectedBranchPatterns: fleetConfig.protected_branch_patterns,
    rulesetName: fleetConfig.ruleset_name,
    appIds: {
      openai: config.apps.openai.id,
      claude: config.apps.claude.id,
      gate: config.apps.gate.id,
    },
  });
  const results = [];
  for (const repository of repositories) {
    const [owner, repo] = repository.full_name.split('/');
    if (!owner || !repo) throw new Error(`Invalid repository: ${repository.full_name}`);
    try {
      results.push({
        repository: repository.full_name,
        ...(await upsertRepositoryRuleset(client, config.admin.token, owner, repo, payload, { dryRun: action === 'plan' })),
      });
    } catch (error) {
      results.push({ repository: repository.full_name, error: error.message, status: error.status ?? null });
      if (action === 'apply' && !flags.continue) break;
    }
  }
  console.log(JSON.stringify(redactObject({ action, enforcement, branch_mode: flags['branch-mode'] ?? 'protected', results }), null, 2));
} else if (group === 'reviewer' && action === 'plan') {
  const token = String(process.env.GITHUB_REVIEWER_TOKEN ?? '').trim();
  if (!token) throw new Error('GITHUB_REVIEWER_TOKEN is required for reviewer planning');
  const hints = flags.hints
    ? await readBoundedJson(resolve(process.cwd(), String(flags.hints)), REVIEWER_HINTS_MAX_BYTES)
    : null;
  const client = new GitHubClient({
    apiBaseUrl: config.github.apiBaseUrl,
    apiVersion: config.github.apiVersion,
  });
  const queue = await buildReviewerQueue({
    client,
    token,
    reviewerLogin: String(flags.reviewer ?? 'the1mills'),
    hints,
    limit: Number(flags.limit ?? 100),
  });
  console.log(JSON.stringify(redactObject(queue), null, 2));
} else if (group === 'canary' && action === 'verify') {
  const evidencePath = String(flags.evidence ?? '').trim();
  if (!evidencePath) throw new Error('Canary verification requires --evidence PATH');
  const evidence = await readBoundedJson(resolve(process.cwd(), evidencePath), MAX_CANARY_EVIDENCE_BYTES);
  const result = verifyCanaryEvidence(evidence, {
    expectedDigest: flags['expected-digest'] ?? null,
  });
  console.log(JSON.stringify(redactObject(result), null, 2));
  if (!result.ok) process.exitCode = 1;
} else {
  usage();
  process.exitCode = 2;
}
