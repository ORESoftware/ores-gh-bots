import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFreshDependencyStates } from '../apps/reaper/src/main.mjs';

test('final dependency resolution uses the fresh dependency set', async () => {
  const calls = [];
  const states = await resolveFreshDependencyStates({
    freshDependencies: [
      'oresoftware/already-merged#1',
      'oresoftware/newly-added#2',
    ],
    mergedKeys: new Set(['oresoftware/already-merged#1']),
    resolveLiveDependency: async (dependency) => {
      calls.push(dependency);
      return 'open';
    },
  });

  assert.deepEqual(states, {
    'oresoftware/already-merged#1': 'merged',
    'oresoftware/newly-added#2': 'open',
  });
  assert.deepEqual(calls, ['oresoftware/newly-added#2']);
});
