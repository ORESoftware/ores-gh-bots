import { REVIEW_SYSTEM_PROMPT, buildReviewEnvelope } from '../../core/src/prompt.mjs';
import { reviewJsonSchema, validateReviewResult } from '../../core/src/review-schema.mjs';
import { postJson } from './http.mjs';

export function buildAnthropicRequest({ model, maxTokens, context }) {
  return {
    model,
    max_tokens: maxTokens,
    system: REVIEW_SYSTEM_PROMPT,
    output_config: {
      format: {
        type: 'json_schema',
        schema: reviewJsonSchema,
      },
    },
    messages: [{ role: 'user', content: buildReviewEnvelope(context) }],
  };
}

export function extractAnthropicReview(response) {
  const blocks = (response?.content ?? []).filter((item) => item.type === 'text' && typeof item.text === 'string');
  if (blocks.length !== 1 || !blocks[0].text) {
    throw new Error(`Anthropic response must contain exactly one structured text result (received=${blocks.length}, stop_reason=${response?.stop_reason ?? 'unknown'})`);
  }
  try {
    return JSON.parse(blocks[0].text);
  } catch {
    throw new Error('Anthropic structured review JSON was invalid');
  }
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
  if (response?.stop_reason === 'refusal') throw new Error('Anthropic refused the review');
  if (response?.stop_reason !== 'end_turn') {
    throw new Error(`Anthropic response did not complete normally (stop_reason=${response?.stop_reason ?? 'unknown'})`);
  }
  return validateReviewResult(extractAnthropicReview(response), {
    maxFindings: context.maxFindings,
    allowApproval: context.collection?.complete !== false,
  });
}
