import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/nightly-pr-reconcile.yml', import.meta.url);
const APP_TOKEN_ACTION = /uses:\s*actions\/create-github-app-token@[0-9a-f]{40}\s*$/mu;

test('nightly reconcile fails before its one-hour GitHub App token can expire', async () => {
  const source = await readFile(WORKFLOW, 'utf8');
  const marker = '\n  reconcile:\n';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'reconcile job must exist');
  const reconcile = source.slice(start + marker.length);

  const timeoutMatch = /^    timeout-minutes:\s*(\d+)\s*$/mu.exec(reconcile);
  assert.ok(timeoutMatch, 'reconcile job must declare a timeout');
  const timeoutMinutes = Number(timeoutMatch[1]);
  assert.ok(Number.isInteger(timeoutMinutes));
  assert.ok(timeoutMinutes < 60, `reconcile timeout ${timeoutMinutes}m must stay below the one-hour installation-token lifetime`);
  assert.ok(timeoutMinutes <= 55, `reconcile timeout ${timeoutMinutes}m must preserve at least five minutes of expiry margin`);

  assert.match(reconcile, APP_TOKEN_ACTION, 'GitHub App token action must remain pinned to an immutable 40-hex revision');
  const mintAt = reconcile.indexOf('- name: Mint organization-scoped GitHub App token');
  const reconcileAt = reconcile.indexOf('- name: Reconcile one organization');
  assert.ok(mintAt >= 0 && reconcileAt > mintAt, 'the organization token must be minted before the effectful reconcile step');

  assert.match(
    reconcile,
    /create-github-app-token installation credentials expire after one hour/u,
    'the credential lifetime boundary must remain documented next to the timeout',
  );
});
