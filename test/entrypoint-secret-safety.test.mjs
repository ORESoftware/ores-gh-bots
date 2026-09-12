import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypointPath = resolve(repositoryRoot, 'entrypoint.sh');

test('entrypoint forwards exact argv without disclosing argument values', () => {
  const sentinel = 'ores-entrypoint-secret-sentinel-9f52b7fd';
  const result = spawnSync(
    '/bin/sh',
    [
      entrypointPath,
      process.execPath,
      '-e',
      'if (process.argv[1] !== process.env.EXPECTED_SENTINEL) process.exit(91)',
      sentinel,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, EXPECTED_SENTINEL: sentinel },
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
  assert.match(result.stderr, /entrypoint: executing command with 4 argument\(s\)/);
});

test('entrypoint fails closed when no command is supplied', () => {
  const result = spawnSync('/bin/sh', [entrypointPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'entrypoint: no command supplied\n');
});
