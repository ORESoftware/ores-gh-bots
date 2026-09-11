import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnthropicRequest,
  buildOpenAIRequest,
  extractAnthropicReview,
  extractOpenAIText,
} from '../packages/providers/src/index.mjs';

const context = {
  repository: 'o/r', number: 1, title: 'T', body: '', author: 'u', baseRef: 'main', headRef: 'x', headSha: 'abc',
  draft: false, additions: 1, deletions: 0, changedFiles: 1, collection: {}, files: [], timeoutMs: 1000, maxFindings: 5,
};

test('OpenAI request uses strict structured output', () => {
  const request = buildOpenAIRequest({ model: 'gpt-test', maxOutputTokens: 1000, context });
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.match(request.input[0].content[0].text, /untrusted data/);
});

test('extracts OpenAI output text', () => {
  assert.equal(extractOpenAIText({ output_text: '{"ok":true}' }), '{"ok":true}');
  assert.throws(() => extractOpenAIText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), /refused/);
});

test('Anthropic request uses native structured output', () => {
  const request = buildAnthropicRequest({ model: 'claude-test', maxTokens: 1000, context });
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.output_config.format.schema.type, 'object');
  assert.equal(request.tools, undefined);
});

test('extracts exactly one Anthropic structured text result', () => {
  const input = { verdict: 'approve' };
  assert.deepEqual(extractAnthropicReview({ content: [{ type: 'text', text: JSON.stringify(input) }] }), input);
  assert.throws(() => extractAnthropicReview({ content: [], stop_reason: 'end_turn' }), /exactly one/);
  assert.throws(() => extractAnthropicReview({
    content: [
      { type: 'text', text: JSON.stringify(input) },
      { type: 'text', text: JSON.stringify(input) },
    ],
    stop_reason: 'end_turn',
  }), /exactly one/);
  assert.throws(() => extractAnthropicReview({ content: [{ type: 'text', text: '{' }] }), /JSON was invalid/);
});
