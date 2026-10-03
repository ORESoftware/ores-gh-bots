import { REVIEW_VERDICTS, SEVERITIES } from './constants.mjs';
import { redactText } from './redact.mjs';

export const reviewJsonSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['approve', 'comment', 'request_changes'] },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    findings: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          path: { type: ['string', 'null'], maxLength: 1000 },
          line: { type: ['integer', 'null'], minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 240 },
          body: { type: 'string', minLength: 1, maxLength: 4000 },
          suggestion: { type: ['string', 'null'], maxLength: 4000 }
        },
        required: ['severity', 'path', 'line', 'title', 'body', 'suggestion']
      }
    },
    tests: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 500 } },
    blocking_reasons: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 1000 } }
  },
  required: ['verdict', 'summary', 'confidence', 'risk', 'findings', 'tests', 'blocking_reasons']
});

function requireString(value, field, { min = 1, max = 4000, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string${nullable ? ' or null' : ''}`);
  const text = redactText(value).trim();
  if (text.length < min || text.length > max) throw new Error(`${field} length is invalid`);
  return text;
}

function requireStringArray(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be an array with at most ${maxItems} items`);
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: maxLength }));
}

export function validateReviewResult(input, { maxFindings = 30 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('review result must be an object');
  if (!REVIEW_VERDICTS.has(input.verdict)) throw new Error('invalid verdict');
  if (!new Set(['low', 'medium', 'high', 'critical']).has(input.risk)) throw new Error('invalid risk');
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  if (!Array.isArray(input.findings) || input.findings.length > Math.min(maxFindings, 50)) {
    throw new Error(`findings must contain at most ${Math.min(maxFindings, 50)} items`);
  }

  const findings = input.findings.map((finding, index) => {
    if (!finding || typeof finding !== 'object' || !SEVERITIES.has(finding.severity)) {
      throw new Error(`findings[${index}] is invalid`);
    }
    const line = finding.line === null ? null : Number(finding.line);
    if (line !== null && (!Number.isInteger(line) || line < 1)) throw new Error(`findings[${index}].line is invalid`);
    return {
      severity: finding.severity,
      path: finding.path === null ? null : requireString(finding.path, `findings[${index}].path`, { max: 1000 }),
      line,
      title: requireString(finding.title, `findings[${index}].title`, { max: 240 }),
      body: requireString(finding.body, `findings[${index}].body`, { max: 4000 }),
      suggestion: finding.suggestion === null ? null : requireString(finding.suggestion, `findings[${index}].suggestion`, { max: 4000 }),
    };
  });

  const result = {
    verdict: input.verdict,
    summary: requireString(input.summary, 'summary', { max: 4000 }),
    confidence: input.confidence,
    risk: input.risk,
    findings,
    tests: requireStringArray(input.tests, 'tests', 30, 500),
    blocking_reasons: requireStringArray(input.blocking_reasons, 'blocking_reasons', 30, 1000),
  };

  if (result.verdict === 'approve' && result.blocking_reasons.length > 0) {
    throw new Error('approved review cannot contain blocking reasons');
  }
  if (result.verdict === 'request_changes' && result.blocking_reasons.length === 0) {
    throw new Error('request_changes must include at least one blocking reason');
  }
  return result;
}
