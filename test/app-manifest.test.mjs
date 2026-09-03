import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForm, convertManifest, parseOptions } from '../scripts/app-manifest.mjs';

const fixedNow = new Date('2026-08-16T03:00:00.000Z');
const documents = {
  manifests: {
    orchestrator: {
      name: 'ORES Review Orchestrator',
      hook_attributes: { url: 'https://replace.example/webhooks/github', active: true },
      redirect_url: 'https://replace.example/github/app-manifest/callback',
    },
    openai: {
      name: 'ORES OpenAI Reviewer',
      redirect_url: 'https://replace.example/github/app-manifest/callback',
      public: true,
      default_permissions: { checks: 'write', metadata: 'read' },
      default_events: [],
    },
  },
};

function privateMode(info) {
  return info.mode & 0o777;
}

test('registration form writes state privately without logging its value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-app-form-'));
  const output = join(dir, 'orchestrator.html');
  const stateFile = join(dir, 'orchestrator.state.json');
  const logs = [];

  await createForm({
    role: 'orchestrator',
    owner: 'ORESoftware',
    'base-url': 'https://bots.example.test',
    output,
    'state-file': stateFile,
  }, {
    now: () => fixedNow,
    randomBytesImpl: () => Buffer.alloc(32, 0xab),
    loadDocuments: async () => documents,
    log: (value) => logs.push(value),
  });

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const html = await readFile(output, 'utf8');
  assert.equal(state.state, 'ab'.repeat(32));
  assert.equal(state.ownerType, 'user');
  assert.match(html, /github\.com\/settings\/apps\/new\?state=/u);
  assert.match(html, /state=abab/u);
  assert.equal(privateMode(await stat(output)), 0o600);
  assert.equal(privateMode(await stat(stateFile)), 0o600);
  assert.equal(logs.some((value) => value.includes(state.state)), false);
  assert.equal(logs.some((value) => value.includes(stateFile)), true);
});

test('registration form targets the explicit organization owner route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-org-app-form-'));
  const output = join(dir, 'openai.html');
  const stateFile = join(dir, 'openai.state.json');

  await createForm({
    role: 'openai',
    owner: 'example-org',
    'owner-type': 'organization',
    'base-url': 'https://bots.example.test',
    output,
    'state-file': stateFile,
  }, {
    now: () => fixedNow,
    randomBytesImpl: () => Buffer.alloc(32, 0xbc),
    loadDocuments: async () => documents,
    log: () => {},
  });

  const html = await readFile(output, 'utf8');
  assert.match(html, /github\.com\/organizations\/example-org\/settings\/apps\/new\?state=/u);
  await assert.rejects(
    createForm({ role: 'openai', owner: 'example-org', 'owner-type': 'enterprise', 'base-url': 'https://bots.example.test' }, {
      loadDocuments: async () => documents,
      log: () => {},
    }),
    /owner-type must be user or organization/u,
  );
});

test('conversion requires matching private state and keeps code out of argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-app-convert-'));
  const form = join(dir, 'openai.html');
  const stateFile = join(dir, 'openai.state.json');
  const output = join(dir, 'openai.env');
  const logs = [];

  await createForm({ role: 'openai', owner: 'ORESoftware', 'base-url': 'https://bots.example.test', output: form, 'state-file': stateFile }, {
    now: () => fixedNow,
    randomBytesImpl: () => Buffer.alloc(32, 0xcd),
    loadDocuments: async () => documents,
    log: () => {},
  });
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  let requestedUrl = null;

  await convertManifest({ role: 'openai', 'state-file': stateFile, output }, {
    now: () => new Date(fixedNow.getTime() + 60_000),
    env: {
      GITHUB_MANIFEST_CODE: 'one-time/code',
      GITHUB_MANIFEST_STATE: state.state,
    },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.method, 'POST');
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        async json() {
          return {
            id: 42,
            slug: 'ores-openai-reviewer',
            pem: '-----BEGIN PRIVATE KEY-----\nvalue\n-----END PRIVATE KEY-----\n',
          };
        },
      };
    },
    log: (value) => logs.push(value),
  });

  assert.match(requestedUrl, /one-time%2Fcode/u);
  const dotenv = await readFile(output, 'utf8');
  assert.match(dotenv, /OPENAI_REVIEW_APP_ID=42/u);
  assert.match(dotenv, /BEGIN PRIVATE KEY/u);
  assert.equal(privateMode(await stat(output)), 0o600);
  await assert.rejects(stat(stateFile), { code: 'ENOENT' });
  assert.equal(logs.some((value) => value.includes('one-time/code')), false);
  assert.equal(logs.some((entry) => entry.includes('-----BEGIN PRIVATE KEY-----')), false);

  await assert.rejects(
    convertManifest({ role: 'openai', code: 'forbidden', 'state-file': stateFile }, { env: {} }),
    /Do not pass the manifest code on the command line/u,
  );
});

test('mismatched or expired callback state fails before GitHub is called', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-app-state-'));
  const form = join(dir, 'openai.html');
  const stateFile = join(dir, 'openai.state.json');
  await createForm({ role: 'openai', owner: 'ORESoftware', 'base-url': 'https://bots.example.test', output: form, 'state-file': stateFile }, {
    now: () => fixedNow,
    randomBytesImpl: () => Buffer.alloc(32, 0xef),
    loadDocuments: async () => documents,
    log: () => {},
  });

  let calls = 0;
  await assert.rejects(
    convertManifest({ role: 'openai', 'state-file': stateFile }, {
      now: () => new Date(fixedNow.getTime() + 60_000),
      env: { GITHUB_MANIFEST_CODE: 'code', GITHUB_MANIFEST_STATE: 'wrong' },
      fetchImpl: async () => { calls += 1; },
    }),
    /callback state did not match/u,
  );
  assert.equal(calls, 0);
  assert.equal((await stat(stateFile)).isFile(), true);

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await assert.rejects(
    convertManifest({ role: 'openai', 'state-file': stateFile }, {
      now: () => new Date(fixedNow.getTime() + (3 * 60 * 60 * 1_000)),
      env: { GITHUB_MANIFEST_CODE: 'code', GITHUB_MANIFEST_STATE: state.state },
      fetchImpl: async () => { calls += 1; },
    }),
    /expired/u,
  );
  assert.equal(calls, 0);
});

test('option parser rejects duplicate flags', () => {
  assert.throws(
    () => parseOptions(['form', '--role', 'openai', '--role', 'gate']),
    /flags-2-env rejected CLI input/u,
  );
});
