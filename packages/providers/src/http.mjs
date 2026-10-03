import { setTimeout as sleep } from 'node:timers/promises';
import { redactText } from '../../core/src/redact.mjs';

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

export async function postJson({ provider, url, headers, body, timeoutMs, fetchImpl = fetch, retries = 2 }) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${provider} request timed out`)), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      const responseBody = contentType.includes('json')
        ? await response.json().catch(() => null)
        : await response.text();
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
