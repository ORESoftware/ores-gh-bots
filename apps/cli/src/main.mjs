#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppAuth,
  buildRulesetPayload,
  GitHubClient,
  listAppInstallations,
  listInstallationRepositories,
  upsertRepositoryRuleset,
} from '../../../packages/github/src/index.mjs';
import {
  createLogger,
  loadConfig,
  ownerIsAllowed,
  redactObject,
  resolveCli,
  validateRuntimeConfig,
} from '../../../packages/core/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
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
`);
}

const cli = resolveCli();
if (cli.help) {
  cli.printHelp();
  process.exit(0);
}
const [group, action] = cli.command.split(' ');
const [subject] = cli.positionals;
const values = cli.values;
const config = loadConfig(cli.env);
const logger = createLogger({ service: 'ores-gh-bots-cli' });

if (group === 'manifest' && action === 'print') {
  const role = subject ?? 'orchestrator';
  const allowed = new Set(['orchestrator', 'openai-reviewer', 'claude-reviewer', 'gate-reviewer', 'actions-dispatcher', 'merge-reaper']);
  if (!allowed.has(role)) throw new Error(`Unknown manifest role: ${role}`);
  console.log(await readFile(resolve(root, `github-apps/${role}.manifest.json`), 'utf8'));
} else if (group === 'fleet' && action === 'discover') {
  validateRuntimeConfig(config, { webhook: false, providers: false });
  const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
  const auth = new AppAuth({ client, apps: config.apps, logger });
  const repositories = await discover({ config, client, auth, limit: Number(values.ORES_CLI_LIMIT ?? config.reconciliation.maxRepos) });
  console.log(JSON.stringify({ count: repositories.length, repositories }, null, 2));
} else if (group === 'rulesets' && ['plan', 'apply'].includes(action)) {
  if (!values.ORES_CLI_REPOSITORY) validateRuntimeConfig(config, { webhook: false, providers: false });
  if (!config.admin.token) throw new Error('GITHUB_ADMIN_TOKEN is required for ruleset planning/application');
  const fleetConfig = await readJson(config.admin.fleetConfigPath);
  const client = new GitHubClient({ apiBaseUrl: config.github.apiBaseUrl, apiVersion: config.github.apiVersion });
  const auth = new AppAuth({ client, apps: config.apps, logger });
  const repositories = values.ORES_CLI_REPOSITORY
    ? [{
      full_name: String(values.ORES_CLI_REPOSITORY),
      owner: String(values.ORES_CLI_REPOSITORY).split('/')[0],
      repo: String(values.ORES_CLI_REPOSITORY).split('/')[1],
    }]
    : await discover({ config, client, auth, limit: Number(values.ORES_CLI_LIMIT ?? config.reconciliation.maxRepos) });
  const enforcement = String(values.ORES_CLI_ENFORCEMENT);
  if (action === 'apply' && enforcement === 'active' && !String(values.ORES_CLI_CONFIRM ?? '').startsWith('ACTIVATE-')) {
    throw new Error('Active enforcement requires --confirm ACTIVATE-<change-ticket>');
  }
  const payload = buildRulesetPayload({
    enforcement,
    branchMode: String(values.ORES_CLI_BRANCH_MODE),
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
      if (action === 'apply' && !values.ORES_CLI_CONTINUE) break;
    }
  }
  console.log(JSON.stringify(redactObject({
    action,
    enforcement,
    branch_mode: values.ORES_CLI_BRANCH_MODE,
    results,
  }), null, 2));
  if (results.some((result) => result.error)) process.exitCode = 1;
} else {
  usage();
  process.exitCode = 2;
}
