import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('fleet hardening uses a dedicated proposal-only GitHub App identity', async () => {
  const [manifestText, policyText, installationsText, secretsText, env, converter, cli] = await Promise.all([
    read('github-apps/fleet-hardening.manifest.json'),
    read('github-apps/policy.json'),
    read('config/installations.example.json'),
    read('config/secrets.example.json'),
    read('.env.example'),
    read('scripts/app-manifest.mjs'),
    read('apps/cli/src/main.mjs'),
  ]);
  const manifest = JSON.parse(manifestText);
  const policy = JSON.parse(policyText);
  const installations = JSON.parse(installationsText);
  const secrets = JSON.parse(secretsText);

  assert.deepEqual(manifest.default_permissions, {
    contents: 'write',
    metadata: 'read',
    pull_requests: 'write',
  });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.public, true);
  assert.equal(Object.hasOwn(manifest.default_permissions, 'checks'), false);
  assert.equal(Object.hasOwn(manifest.default_permissions, 'administration'), false);
  assert.equal(Object.hasOwn(manifest.default_permissions, 'workflows'), false);

  assert.deepEqual(policy.apps.hardening.permissions, manifest.default_permissions);
  assert.equal(policy.apps.hardening.installationScope, 'fleet');
  assert.deepEqual(policy.apps.hardening.secretEnv, [
    'FLEET_HARDENING_APP_ID',
    'FLEET_HARDENING_APP_PRIVATE_KEY',
  ]);
  assert.ok(installations.apps.hardening);
  assert.ok(secrets.requiredKeys.includes('FLEET_HARDENING_APP_ID'));
  assert.ok(secrets.requiredKeys.includes('FLEET_HARDENING_APP_PRIVATE_KEY'));
  assert.match(env, /^FLEET_HARDENING_APP_ID=/mu);
  assert.match(env, /^FLEET_HARDENING_APP_PRIVATE_KEY=/mu);
  assert.match(converter, /hardening:\s*\{[\s\S]*FLEET_HARDENING_APP_ID/u);
  assert.match(cli, /'fleet-hardening'/u);
});

test('hosted fleet hardening workflow is planning-only and does not expose private plan contents', async () => {
  const workflow = await read('.github/workflows/fleet-hardening.yml');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s*schedule:/mu);
  assert.doesNotMatch(workflow, /GITHUB_ADMIN_TOKEN/u);
  assert.doesNotMatch(workflow, /hardening apply/u);
  assert.match(workflow, /hardening plan/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run build:flags2env/u);
  assert.match(workflow, /npm run check && npm run verify/u);
  assert.match(workflow, /private_plan_uploaded:\s*false/u);
  assert.match(workflow, /rmSync\('fleet-hardening-plan\.json'\)/u);
  assert.doesNotMatch(workflow, /path:\s*fleet-hardening-plan\.json/u);
});

test('canonical hardening CLI binds plans to the admission wrapper implementation', async () => {
  const [cli, index, legacy] = await Promise.all([
    read('apps/cli/src/hardening.mjs'),
    read('packages/github/src/index.mjs'),
    read('packages/github/src/hardening.mjs'),
  ]);
  assert.match(cli, /fleet-hardening-plan-admission\.mjs/u);
  assert.match(index, /export \* from '\.\/fleet-hardening-plan-admission\.mjs'/u);
  assert.doesNotMatch(index, /export \* from '\.\/fleet-hardening-plan\.mjs'/u);
  assert.match(legacy, /Legacy direct fleet-hardening apply is disabled/u);
  assert.match(legacy, /Direct default-branch file writes are forbidden/u);
});
