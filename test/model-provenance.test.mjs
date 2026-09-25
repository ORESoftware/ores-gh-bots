import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_MODELS,
  evaluateGate,
  providerModelMatches,
  requireProviderModel,
} from '../packages/core/src/index.mjs';
import { reviewWithAnthropic, reviewWithOpenAI } from '../packages/providers/src/index.mjs';

const APPROVED = Object.freeze({
  verdict: 'approve',
  summary: 'Looks correct.',
  confidence: 0.93,
  risk: 'low',
  findings: [],
  tests: [],
  blocking_reasons: [],
});

const CONTEXT = Object.freeze({
  repository: 'O/R',
  number: 1,
  title: 'Test',
  body: '',
  author: 'alex',
  baseRef: 'main',
  headRef: 'feature',
  headSha: 'a'.repeat(40),
  draft: false,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  collection: {},
  files: [],
  timeoutMs: 1_000,
  maxFindings: 5,
});

function json(body) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

test('model identity accepts the exact family or a dated immutable snapshot only', () => {
  assert.equal(providerModelMatches('gpt-6-astra', 'gpt-6-astra'), true);
  assert.equal(providerModelMatches('gpt-6-astra', 'gpt-6-astra-2026-09-03'), true);
  assert.equal(providerModelMatches('gpt-6-astra', 'gpt-6-astra-preview'), false);
  assert.equal(providerModelMatches('gpt-6-astra', 'gpt-5-mini'), false);
  assert.equal(providerModelMatches('gpt-6-astra-2026-09-03', 'gpt-6-astra-2026-09-04'), false);
  assert.throws(
    () => requireProviderModel({ provider: 'OpenAI', expected: 'gpt-6-astra', observed: null }),
    /did not report a valid model identity/,
  );
});

test('OpenAI and Anthropic adapters fail closed when the transport reports the wrong model', async () => {
  await assert.rejects(() => reviewWithOpenAI({
    config: { apiKey: 'test', baseUrl: 'https://openai.test', model: REVIEW_MODELS.openai, maxOutputTokens: 1_000 },
    context: CONTEXT,
    fetchImpl: () => json({ status: 'completed', model: 'gpt-5-mini', output_text: JSON.stringify(APPROVED) }),
  }), /OpenAI model identity mismatch/);

  await assert.rejects(() => reviewWithAnthropic({
    config: { apiKey: 'test', baseUrl: 'https://anthropic.test', model: REVIEW_MODELS.claude, maxTokens: 1_000, version: '2023-06-01' },
    context: CONTEXT,
    fetchImpl: () => json({
      model: 'claude-sonnet-4-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'submit_code_review', input: APPROVED }],
    }),
  }), /Anthropic model identity mismatch/);
});

test('aggregate gate rejects same-head approvals without the configured model provenance', () => {
  const validReviews = {
    openai: { ...APPROVED, model: REVIEW_MODELS.openai },
    claude: { ...APPROVED, model: REVIEW_MODELS.claude },
  };
  assert.equal(evaluateGate({ reviews: validReviews, requiredProviderModels: REVIEW_MODELS }).conclusion, 'success');

  const stale = evaluateGate({
    reviews: { ...validReviews, openai: { ...APPROVED, model: 'gpt-5-mini' } },
    requiredProviderModels: REVIEW_MODELS,
  });
  assert.equal(stale.conclusion, 'failure');

  const missing = evaluateGate({
    reviews: { ...validReviews, claude: { ...APPROVED } },
    requiredProviderModels: REVIEW_MODELS,
  });
  assert.equal(missing.conclusion, 'failure');
});
