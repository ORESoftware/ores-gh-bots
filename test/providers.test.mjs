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

test('Anthropic request forces exactly one review tool', () => {
  const request = buildAnthropicRequest({ model: 'claude-test', maxTokens: 1000, context });
  assert.deepEqual(request.tool_choice, { type: 'tool', name: 'submit_code_review' });
  assert.equal(request.disable_parallel_tool_use, true);
});

test('extracts the forced Anthropic tool result', () => {
  const input = { verdict: 'approve' };
  assert.equal(extractAnthropicReview({ content: [{ type: 'tool_use', name: 'submit_code_review', input }] }), input);
  assert.throws(() => extractAnthropicReview({ content: [], stop_reason: 'end_turn' }), /did not call/);
});
