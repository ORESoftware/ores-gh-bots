import { REVIEW_SYSTEM_PROMPT, buildReviewEnvelope } from '../../core/src/prompt.mjs';
import { reviewJsonSchema, validateReviewResult } from '../../core/src/review-schema.mjs';
import { postJson } from './http.mjs';

export function buildOpenAIRequest({ model, maxOutputTokens, context }) {
  return {
    model,
    store: false,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: 'developer',
        content: [{ type: 'input_text', text: REVIEW_SYSTEM_PROMPT }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: buildReviewEnvelope(context) }],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'ores_code_review',
        description: 'A merge-gating pull-request review.',
        strict: true,
        schema: reviewJsonSchema,
      },
    },
  };
}

export function extractOpenAIText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  const texts = [];
  for (const item of response?.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') texts.push(content.text);
      if (content.type === 'refusal') throw new Error(`OpenAI refused the review: ${content.refusal ?? 'unspecified refusal'}`);
    }
  }
  if (!texts.length) throw new Error('OpenAI response did not contain output text');
  return texts.join('');
}

export async function reviewWithOpenAI({ config, context, fetchImpl = fetch }) {
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const response = await postJson({
    provider: 'OpenAI',
    url: `${config.baseUrl.replace(/\/$/, '')}/v1/responses`,
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: buildOpenAIRequest({ model: config.model, maxOutputTokens: config.maxOutputTokens, context }),
    timeoutMs: context.timeoutMs,
    fetchImpl,
  });
  if (response?.status && response.status !== 'completed') {
    throw new Error(`OpenAI response status was ${response.status}`);
  }
  const parsed = JSON.parse(extractOpenAIText(response));
  return validateReviewResult(parsed, {
    maxFindings: context.maxFindings,
    allowApproval: context.collection?.complete !== false,
  });
}
