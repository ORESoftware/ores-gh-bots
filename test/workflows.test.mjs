import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dispatchPath = new URL('../.github/workflows/review-dispatch.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const nightlyReaperPath = new URL('../.github/workflows/nightly-merge-reaper.yml', import.meta.url);
const canaryKustomizationPath = new URL('../deploy/kubernetes/overlays/canary/kustomization.yaml', import.meta.url);
const productionKustomizationPath = new URL('../deploy/kubernetes/overlays/production/kustomization.yaml', import.meta.url);
const dockerfilePath = new URL('../Dockerfile', import.meta.url);
const composePath = new URL('../docker-compose.yml', import.meta.url);

test('review dispatch keeps untrusted workflow inputs out of shell source', async () => {
  const workflow = await readFile(dispatchPath, 'utf8');
  const runBlock = workflow.slice(workflow.indexOf('- name: Review exact pull-request head'));
  assert.match(runBlock, /run: node apps\/runner\/src\/main\.mjs/u);
  assert.doesNotMatch(runBlock.match(/run:.*$/mu)?.[0] ?? '', /\$\{\{\s*inputs\./u);
  assert.match(workflow, /OWNER_ALLOWLIST: \$\{\{ vars\.OWNER_ALLOWLIST \}\}/u);
  assert.match(workflow, /REQUIRED_CI_APP_IDS: \$\{\{ vars\.REQUIRED_CI_APP_IDS \}\}/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
});

test('validation workflow does not persist the GitHub token into the checkout', async () => {
  const workflow = await readFile(ciPath, 'utf8');
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /bash --noprofile --norc -euo pipefail/u);
  assert.match(workflow, /run: npm ci\s*$/mu);
  assert.doesNotMatch(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /docker build --pull=false --tag ores-gh-bots:\$\{\{ github\.sha \}\}/u);
});

test('container bases are digest-pinned and canary selectors cannot overlap production', async () => {
  const [dockerfile, compose, canary, production] = await Promise.all([
    readFile(dockerfilePath, 'utf8'),
    readFile(composePath, 'utf8'),
    readFile(canaryKustomizationPath, 'utf8'),
    readFile(productionKustomizationPath, 'utf8'),
  ]);
  assert.equal((dockerfile.match(/^FROM .*@sha256:[0-9a-f]{64}/gmu) ?? []).length, 2);
  assert.match(compose, /env_file: env\/dec\/review-bots\.env/u);
  assert.doesNotMatch(compose, /env_file: \.env/u);
  assert.match(canary, /app\.kubernetes\.io\/instance: canary/u);
  assert.match(production, /app\.kubernetes\.io\/instance: production/u);
  assert.match(canary, /includeSelectors: true/u);
  assert.match(production, /includeSelectors: true/u);
});


test('nightly merge reaper is local-time gated, App-authenticated, exact-head, and capped at three effects', async () => {
  const workflow = await readFile(nightlyReaperPath, 'utf8');
  assert.match(workflow, /America\/Chicago/u);
  assert.equal((workflow.match(/- cron: '7 [67] \* \* \*'/gu) ?? []).length, 2);
  assert.match(workflow, /admitted = manual or \(local\.hour == 1 and local\.fold == 0\)/u);
  assert.doesNotMatch(workflow, /admitted = manual or local\.hour == 1\s*$/mu);
  assert.match(workflow, /fold: `\{local\.fold\}`/u);
  assert.match(workflow, /MERGE_REAPER_APP_ID: \$\{\{ secrets\.MERGE_REAPER_APP_ID \}\}/u);
  assert.match(workflow, /MERGE_REAPER_APP_PRIVATE_KEY: \$\{\{ secrets\.MERGE_REAPER_APP_PRIVATE_KEY \}\}/u);
  assert.match(workflow, /GATE_APP_ID: \$\{\{ secrets\.GATE_APP_ID \}\}/u);
  assert.match(workflow, /MERGE_REAPER_MAX_MERGES: \$\{\{ inputs\.max_merges \|\| '3' \}\}/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /run: node apps\/reaper\/src\/main\.mjs reaper apply/u);
  assert.doesNotMatch(workflow.match(/run: node apps\/reaper\/src\/main\.mjs reaper apply.*$/mu)?.[0] ?? '', /\$\{\{\s*inputs\./u);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN|github\.token/u);
});
