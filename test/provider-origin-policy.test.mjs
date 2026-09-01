import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateRuntimeConfig } from '../packages/core/src/index.mjs';

function env(overrides = {}) {
  return {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'orchestrator-key',
    OPENAI_REVIEW_APP_ID: '2',
    OPENAI_REVIEW_APP_PRIVATE_KEY: 'openai-app-key',
    CLAUDE_REVIEW_APP_ID: '3',
    CLAUDE_REVIEW_APP_PRIVATE_KEY: 'claude-app-key',
    GATE_APP_ID: '4',
    GATE_APP_PRIVATE_KEY: 'gate-app-key',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    ...overrides,
  };
}

test('official provider origins are allowed by default', () => {
  assert.doesNotThrow(() => validateRuntimeConfig(loadConfig(env())));
});

test('arbitrary provider origins fail closed', () => {
  const config = loadConfig(env({ OPENAI_BASE_URL: 'https://attacker.example' }));
  assert.throws(() => validateRuntimeConfig(config), /OpenAI base URL origin is not allowed/);
});

test('provider base URLs must use HTTPS even when explicitly allowlisted', () => {
  assert.throws(
    () => loadConfig(env({
      OPENAI_BASE_URL: 'http://proxy.example',
      PROVIDER_ALLOWED_ORIGINS: 'http://proxy.example,https://api.anthropic.com',
    })),
    /PROVIDER_ALLOWED_ORIGINS entries must be credential-free HTTPS origins/,
  );
});

test('custom HTTPS provider proxy requires explicit origin allowlisting', () => {
  const config = loadConfig(env({
    OPENAI_BASE_URL: 'https://proxy.example/openai',
    PROVIDER_ALLOWED_ORIGINS: 'https://proxy.example,https://api.anthropic.com',
  }));
  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test('provider base URLs reject embedded credentials and query material', () => {
  const credentialed = loadConfig(env({
    OPENAI_BASE_URL: 'https://user:pass@api.openai.com',
  }));
  assert.throws(() => validateRuntimeConfig(credentialed), /must not contain credentials/);

  const queried = loadConfig(env({
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com?token=secret',
  }));
  assert.throws(() => validateRuntimeConfig(queried), /must not contain a query string or fragment/);
});

test('provider allowlist accepts origins only, not paths or credentials', () => {
  assert.throws(
    () => loadConfig(env({ PROVIDER_ALLOWED_ORIGINS: 'https://proxy.example/path' })),
    /entries must be credential-free HTTPS origins/,
  );
  assert.throws(
    () => loadConfig(env({ PROVIDER_ALLOWED_ORIGINS: 'https://user:pass@proxy.example' })),
    /entries must be credential-free HTTPS origins/,
  );
});
