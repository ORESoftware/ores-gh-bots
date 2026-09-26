import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../packages/github/src/client.mjs';

const client = (more) => new GitHubClient({ fetchImpl: async () => new Response('[1]', {
  headers: { 'content-type': 'application/json', ...(more ? {
    link: '<https://api.github.com/items?page=2>; rel="next"',
  } : {}) },
}) });

test('complete evidence refuses a truncated successful prefix', async () => {
  await assert.rejects(() => client(true).paginate('/items', { maxPages: 1, requireComplete: true }),
    /Pagination limit/);
  assert.deepEqual(await client(false).paginate('/items', { maxPages: 1, requireComplete: true }), [1]);
});

test('intentional bounded discovery remains supported', async () => {
  assert.deepEqual(await client(true).paginate('/items', { maxPages: 1 }), [1]);
});

test('invalid page ceilings fail instead of returning empty evidence', async () => {
  for (const maxPages of [0, -1, 0.5, NaN, Infinity]) {
    await assert.rejects(() => client(false).paginate('/items', { maxPages }), /maxPages/);
  }
});
