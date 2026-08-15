import { REVIEW_SYSTEM_PROMPT, buildReviewEnvelope } from '../../core/src/prompt.mjs';
import { reviewJsonSchema, validateReviewResult } from '../../core/src/review-schema.mjs';
import { postJson } from './http.mjs';

export function buildAnthropicRequest({ model, maxTokens, context }) {
  return {
    model,
    max_tokens: maxTokens,
    system: REVIEW_SYSTEM_PROMPT,
    tools: [{
      name: 'submit_code_review',
      description: 'Submit the final merge-gating code review. Always call this tool exactly once after analyzing the untrusted pull-request data.',
      input_schema: reviewJsonSchema,
    }],
    tool_choice: { type: 'tool', name: 'submit_code_review' },
    disable_parallel_tool_use: true,
    messages: [{ role: 'user', content: buildReviewEnvelope(context) }],
  };
}

export function extractAnthropicReview(response) {
  const block = response?.content?.find((item) => item.type === 'tool_use' && item.name === 'submit_code_review');
  if (!block) throw new Error(`Anthropic response did not call submit_code_review (stop_reason=${response?.stop_reason ?? 'unknown'})`);
  return block.input;
}

export async function reviewWithAnthropic({ config, context, fetchImpl = fetch }) {
  if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const response = await postJson({
    provider: 'Anthropic',
    url: `${config.baseUrl.replace(/\/$/, '')}/v1/messages`,
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': config.version,
    },
    body: buildAnthropicRequest({ model: config.model, maxTokens: config.maxTokens, context }),
    timeoutMs: context.timeoutMs,
    fetchImpl,
  });
  if (response?.stop_reason === 'max_tokens') throw new Error('Anthropic review was truncated at max_tokens');
  return validateReviewResult(extractAnthropicReview(response), { maxFindings: context.maxFindings });
}
