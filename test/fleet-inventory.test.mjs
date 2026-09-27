import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFleetInventory } from '../packages/github/src/fleet-inventory.mjs';

const installation = (extra = {}) => ({ id: 1, account: { login: 'example' }, repository_selection: 'all', ...extra });
const repository = (extra = {}) => ({ id: 2, owner: { login: 'example' }, name: 'app', full_name: 'example/app',
  private: true, archived: false, disabled: false, default_branch: 'main', ...extra });
function fixture({ installations = [installation()], repositories = [repository()], error = false } = {}) {
  const calls = [];
  return { calls, expectedOwners: ['example'], ownerIsAllowed: () => true,
    auth: { appJwt: () => 'app-token', installationToken: async () => 'installation-token' },
    client: { paginate: async (path, options) => {
      calls.push({ path, options });
      assert.equal(options.requireComplete, true);
      if (path.startsWith('/app/')) {
        return options.map(installations);
      }
      if (error) {
        throw new Error('provider error contains secret-value');
      }
      return options.map({ repositories, total_count: repositories.length });
    } },
  };
}

test('inventory includes archived/private repositories and leaves unknown roles explicit', async () => {
  const result = await collectFleetInventory(fixture({ repositories: [repository({ archived: true })] }));
  assert.equal(result.enumeration_complete, true);
  assert.equal(result.ownership_inventory_complete, false);
  assert.equal(result.repositories[0].archived, true);
  assert.equal(result.repositories[0].role, null);
  assert.equal(result.repositories[0].dependencies, null);
  assert.equal(result.repository_count, 1);
});

test('missing installations are visible even when discovery returns no results', async () => {
  const result = await collectFleetInventory(fixture({ installations: [] }));
  assert.equal(result.enumeration_complete, false);
  assert.deepEqual(result.missing_expected_owners, ['example']);
});

test('an inaccessible installation stays uninspected without leaking provider text', async () => {
  const result = await collectFleetInventory(fixture({ error: true }));
  assert.equal(result.enumeration_complete, false);
  assert.equal(result.installations[0].status, 'uninspected');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});

test('suspended installations are not queried or omitted', async () => {
  const input = fixture({ installations: [installation({ suspended_at: '2026-09-26' })] });
  const result = await collectFleetInventory(input);
  assert.equal(result.installations[0].status, 'suspended');
  assert.equal(input.calls.length, 1);
  assert.equal(result.enumeration_complete, false);
});

test('selected-repository visibility never becomes an ownership inventory claim', async () => {
  const result = await collectFleetInventory(fixture({ installations: [installation({ repository_selection: 'selected' })] }));
  assert.equal(result.installations[0].repository_selection, 'selected');
  assert.equal(result.ownership_inventory_complete, false);
});

test('malformed or duplicated repository identities invalidate the installation', async () => {
  for (const repositories of [[repository(), repository()], [repository({ full_name: 'other/app' })],
    [repository({ id: null })], [repository({ name: '../app' })]]) {
    const result = await collectFleetInventory(fixture({ repositories }));
    assert.equal(result.enumeration_complete, false);
    assert.equal(result.repository_count, 0);
  }
});

test('owner admission happens before minting repository access', async () => {
  const input = fixture();
  const result = await collectFleetInventory({ ...input, ownerIsAllowed: () => false });
  assert.equal(input.calls.length, 1);
  assert.deepEqual(result.missing_expected_owners, ['example']);
});

test('case-insensitive expected owners are deduplicated', async () => {
  const result = await collectFleetInventory({ ...fixture(), expectedOwners: ['EXAMPLE', 'example'] });
  assert.deepEqual(result.missing_expected_owners, []);
});

test('unsafe ceilings and malformed installations fail closed', async () => {
  for (const maxPages of [0, -1, 0.5, Infinity]) {
    await assert.rejects(() => collectFleetInventory({ ...fixture(), maxPages }), /Invalid inventory/);
  }
  await assert.rejects(() => collectFleetInventory(fixture({ installations: [installation(), installation()] })), /duplicate/);
  await assert.rejects(() => collectFleetInventory(fixture({ installations: [installation({ account: null })] })), /installation identity/);
});

test('a missing page cannot look complete merely because the transport stopped', async () => {
  const input = fixture();
  const paginate = input.client.paginate;
  const result = await collectFleetInventory({ ...input, client: { paginate: async (path, options) => {
    if (path.startsWith('/app/')) {
      return paginate(path, options);
    }
    return options.map({ repositories: [repository()], total_count: 2 });
  } } });
  assert.equal(result.enumeration_complete, false);
  assert.equal(result.installations[0].status, 'uninspected');
});

test('repository totals changing across pages invalidate the snapshot', async () => {
  const input = fixture();
  const paginate = input.client.paginate;
  const result = await collectFleetInventory({ ...input, client: { paginate: async (path, options) => {
    if (path.startsWith('/app/')) {
      return paginate(path, options);
    }
    return [...options.map({ repositories: [repository()], total_count: 1 }),
      ...options.map({ repositories: [], total_count: 0 })];
  } } });
  assert.equal(result.enumeration_complete, false);
});
