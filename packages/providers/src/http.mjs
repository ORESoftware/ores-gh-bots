import { setTimeout as sleep } from 'node:timers/promises';
import { redactText } from '../../core/src/redact.mjs';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ProviderHttpError extends Error {
  constructor(provider, status, body, retryAfterMs = null) {
    super(`${provider} API failed with HTTP ${status}: ${redactText(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 1000)}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1000, timestamp - Date.now()) : null;
}

async function readBoundedBody(response, provider, maxResponseBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    throw new Error(`${provider} response exceeded ${maxResponseBytes} bytes`);
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new Error(`${provider} response exceeded ${maxResponseBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${provider} response exceeded ${maxResponseBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export async function postJson({
  provider,
  url,
  headers,
  body,
  timeoutMs,
  fetchImpl = fetch,
  retries = 2,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) {
    throw new Error('maxResponseBytes must be an integer >= 1024');
  }

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${provider} request timed out`)), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      const contentType = response.headers.get('content-type') ?? '';
      const rawBody = await readBoundedBody(response, provider, maxResponseBytes);
      const responseBody = contentType.includes('json')
        ? rawBody ? JSON.parse(rawBody) : null
        : rawBody;
      if (response.ok) return responseBody;
      const delay = retryAfter(response);
      if (attempt < retries && (delay !== null || response.status === 429 || response.status >= 500)) {
        await sleep(delay ?? Math.min(10_000, 750 * 2 ** attempt));
        continue;
      }
      throw new ProviderHttpError(provider, response.status, responseBody, delay);
    } finally {
      clearTimeout(timer);
    }
  }
}
