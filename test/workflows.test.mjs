import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dispatchPath = new URL('../.github/workflows/review-dispatch.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);

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
});
