import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const ACTION_SHA = /^[0-9a-f]{40}$/u;

function actionReferences(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*/gmu)].map((match) => match[1]);
}

test('merge reaper has one canonical CLI and dedicated App boundary', async () => {
  const [cli, manifestText, policyText, inventoryText, schemaText, secretsText, env, bootstrap, cliSource] = await Promise.all([
    read('.cli-flags.toml'),
    read('github-apps/merge-reaper.manifest.json'),
    read('github-apps/policy.json'),
    read('config/installations.example.json'),
    read('config/installations.schema.json'),
    read('config/secrets.example.json'),
    read('.env.example'),
    read('scripts/app-manifest.mjs'),
    read('apps/cli/src/main.mjs'),
  ]);
  const manifest = JSON.parse(manifestText);
  const policy = JSON.parse(policyText);
  const inventory = JSON.parse(inventoryText);
  const schema = JSON.parse(schemaText);
  const secrets = JSON.parse(secretsText);

  assert.match(cli, /^\[commands\.reaper\]$/mu);
  assert.match(cli, /^\[commands\.reaper\.commands\.plan\]$/mu);
  assert.match(cli, /^\[commands\.reaper\.commands\.apply\]$/mu);
  assert.match(cli, /env = "MERGE_REAPER_CONFIRM"/u);

  assert.deepEqual(manifest.default_permissions, {
    checks: 'read',
    contents: 'write',
    metadata: 'read',
    pull_requests: 'write',
    statuses: 'read',
  });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.public, true);
  assert.equal(Object.hasOwn(manifest, 'redirect_url'), false);
  assert.equal(Object.hasOwn(manifest, 'hook_attributes'), false);

  assert.deepEqual(policy.apps.reaper.permissions, manifest.default_permissions);
  assert.equal(policy.apps.reaper.installationScope, 'fleet');
  assert.deepEqual(policy.apps.reaper.secretEnv, [
    'MERGE_REAPER_APP_ID',
    'MERGE_REAPER_APP_PRIVATE_KEY',
  ]);
  assert.ok(inventory.apps.reaper);
  assert.equal(inventory.apps.reaper.visibility, 'public-unlisted');
  assert.ok(schema.properties.apps.required.includes('reaper'));
  assert.ok(schema.properties.apps.properties.reaper);
  assert.ok(secrets.requiredKeys.includes('MERGE_REAPER_APP_ID'));
  assert.ok(secrets.requiredKeys.includes('MERGE_REAPER_APP_PRIVATE_KEY'));
  assert.match(env, /^MERGE_REAPER_APP_ID=/mu);
  assert.match(env, /^MERGE_REAPER_APP_PRIVATE_KEY=/mu);
  assert.match(bootstrap, /reaper:\s*\{\s*id:\s*'MERGE_REAPER_APP_ID',\s*pem:\s*'MERGE_REAPER_APP_PRIVATE_KEY'/su);
  assert.match(cliSource, /'merge-reaper'/u);
});

test('merge reaper workflow preserves supply-chain and report boundaries', async () => {
  const workflow = await read('.github/workflows/nightly-merge-reaper.yml');
  const references = actionReferences(workflow);
  assert.ok(references.length >= 3);
  for (const reference of references) {
    const separator = reference.lastIndexOf('@');
    assert.ok(separator > 0, `${reference} must carry a revision`);
    assert.match(reference.slice(separator + 1), ACTION_SHA, `${reference} must be SHA pinned`);
  }

  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run build:flags2env/u);
  assert.match(workflow, /npm run check && npm run verify/u);
  assert.doesNotMatch(workflow, /^\s*run:\s*npm ci\s*$/mu);
  assert.doesNotMatch(workflow, /GITHUB_PAT|GH_PAT|PERSONAL_ACCESS_TOKEN|FLEET_PR_TOKEN/u);
  assert.match(workflow, /node apps\/reaper\/src\/main\.mjs reaper plan/u);
  assert.match(workflow, /node apps\/reaper\/src\/main\.mjs reaper apply/u);
  assert.match(workflow, /MERGE_REAPER_APP_ID/u);
  assert.match(workflow, /MERGE_REAPER_APP_PRIVATE_KEY/u);
  assert.match(workflow, /merge-reaper-public-report\.json/u);
  assert.doesNotMatch(workflow, /path:\s*merge-reaper-report\.json/u);
  assert.match(workflow, /rmSync\('merge-reaper-report\.json'\)/u);
  assert.match(workflow, /currentHour === 1 && previousHour !== 1/u);
});

test('runtime keeps exact-head merge and bounded-effect invariants visible at the executable boundary', async () => {
  const [source, policyText] = await Promise.all([
    read('apps/reaper/src/main.mjs'),
    read('config/merge-reaper.example.json'),
  ]);
  const policy = JSON.parse(policyText);

  assert.equal(policy.maxMerges, 3);
  assert.equal(policy.requireOptInLabel, true);
  assert.ok(policy.optInLabels.length > 0);
  assert.ok(policy.denyLabels.length > 0);
  assert.match(source, /findLatestCheckRun/u);
  assert.match(source, /getCiSnapshot/u);
  assert.match(source, /countUnresolvedReviewThreads/u);
  assert.match(source, /listMergeReaperPullRequestReviews/u);
  assert.match(source, /freshInspection/u);
  assert.match(source, /mergePullRequestExact/u);
  assert.match(source, /expectedHeadSha:\s*fresh\.headSha/u);
  assert.match(source, /selectMergeBatch\(ordered, policy\.maxMerges\)/u);
  assert.match(source, /mode:\s*0o600/u);
  assert.match(source, /privateMetadataRedacted:\s*true/u);
  assert.match(source, /Merge reaper and gate GitHub App identities must be distinct/u);
  assert.match(source, /\^MERGE-/u);
  assert.match(source, /policy\.requireHumanApproval/u);
  assert.match(source, /auth\.installationToken\('reaper', repository\.installationId\)/u);
  assert.doesNotMatch(source, /repository\.token/u);
});
