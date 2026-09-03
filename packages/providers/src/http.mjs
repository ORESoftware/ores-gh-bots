import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export class ProviderHttpError extends Error {
  constructor(provider, status, _body, retryAfterMs = null) {
    // Upstream bodies can reflect arbitrary secrets. Never retain them in an
    // error message, property, or cause that a worker might persist or log.
    super(`${provider} API failed with HTTP ${status}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderTransportError extends Error {
  constructor(provider, code, message) {
    super(`${provider} ${message}`);
    this.name = 'ProviderTransportError';
    this.code = code;
  }
}

/** Parse Retry-After without negative delays, permissive numeric dates, or timer overflow. */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    return Math.min(Number.MAX_SAFE_INTEGER, Number(text) * 1000);
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(text)) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function cancelBody(body) {
  try { void Promise.resolve(body?.cancel()).catch(() => {}); }
  catch { /* Cancellation is best-effort and must not block the deadline. */ }
}

// Even injected transports/readers must not be able to ignore our deadline.
function abortable(start, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (callback, value) => {
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    try {
      Promise.resolve(start()).then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
    } catch (error) { settle(reject, error); }
  });
}

async function readBoundedBody(response, provider, maxResponseBytes, signal) {
  const overflow = () => new ProviderTransportError(provider, 'PROVIDER_RESPONSE_LIMIT', `response exceeded ${maxResponseBytes} bytes`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    cancelBody(response.body);
    throw overflow();
  }
  if (!response.body) return '';
  // Do not fall back to text(): it would allocate the entire unbounded body.
  if (typeof response.body.getReader !== 'function') {
    cancelBody(response.body);
    throw new ProviderTransportError(provider, 'PROVIDER_PROTOCOL', 'response is not a readable byte stream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) {
        throw new ProviderTransportError(provider, 'PROVIDER_PROTOCOL', 'response stream returned a non-byte chunk');
      }
      total += value.byteLength;
      if (total > maxResponseBytes) throw overflow();
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    if (!complete) {
      try { void Promise.resolve(reader.cancel()).catch(() => {}); }
      catch { /* Do not let cancellation errors hide the safe primary error. */ }
    }
    try { reader.releaseLock(); }
    catch { /* An outstanding read is already observed by abortable(). */ }
  }
}

/** Bounded retries of explicit HTTP rejections, within one end-to-end deadline. */
export async function postJson({
  provider,
  url,
  headers,
  body,
  timeoutMs,
  fetchImpl = fetch,
  retries = 2,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRetryDelayMs = 10_000,
  signal,
  sleepImpl = sleep,
}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error('maxResponseBytes must be an integer >= 1024 and <= 16777216');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new Error('timeoutMs must be a positive integer within the Node timer range');
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new Error('retries must be an integer from 0 to 5');
  if (!Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < 1 || maxRetryDelayMs > 60_000) {
    throw new Error('maxRetryDelayMs must be an integer from 1 to 60000');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('signal must be an AbortSignal');
  if (typeof fetchImpl !== 'function' || typeof sleepImpl !== 'function') throw new Error('HTTP dependencies must be functions');

  const controller = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeoutError = new ProviderTransportError(provider, 'PROVIDER_TIMEOUT', 'request timed out');
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const assertActive = () => {
    if (operationSignal.aborted) throw operationSignal.reason;
    if (performance.now() >= deadline) { controller.abort(timeoutError); throw timeoutError; }
  };
  try {
    assertActive();
    let requestBody;
    try { requestBody = JSON.stringify(body); }
    catch { throw new ProviderTransportError(provider, 'PROVIDER_REQUEST_INVALID', 'request JSON serialization failed'); }
    if (typeof requestBody !== 'string') throw new ProviderTransportError(provider, 'PROVIDER_REQUEST_INVALID', 'request JSON is missing');

    for (let attempt = 0; ; attempt += 1) {
      assertActive();
      const response = await abortable(async () => {
        const result = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: requestBody,
          signal: operationSignal,
          redirect: 'error',
        });
        // A nonconforming transport might resolve after cancellation.
        if (operationSignal.aborted) cancelBody(result?.body);
        return result;
      }, operationSignal);
      assertActive();
      if (!response.ok) {
        // Classify status without parsing/logging an untrusted HTML/error body.
        cancelBody(response.body);
        const requestedDelay = parseRetryAfterMs(response.headers.get('retry-after'));
        const error = new ProviderHttpError(provider, response.status, null, requestedDelay);
        const retryable = RETRYABLE_STATUSES.has(response.status) && response.headers.get('x-should-retry') !== 'false';
        if (!retryable || attempt >= retries) throw error;
        const delay = requestedDelay ?? Math.min(maxRetryDelayMs, 750 * 2 ** attempt);
        // Never shorten a server-requested delay or overflow setTimeout. Leave
        // longer waits to the caller instead of retrying early.
        if (delay > maxRetryDelayMs || delay >= deadline - performance.now()) throw error;
        await abortable(() => sleepImpl(delay, undefined, { signal: operationSignal }), operationSignal);
        continue;
      }

      const rawBody = await readBoundedBody(response, provider, maxResponseBytes, operationSignal);
      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
        throw new ProviderTransportError(provider, 'PROVIDER_PROTOCOL', 'response content type is not JSON');
      }
      let parsed;
      try { parsed = JSON.parse(rawBody); }
      catch { throw new ProviderTransportError(provider, 'PROVIDER_PROTOCOL', 'response JSON is invalid'); }
      assertActive();
      return parsed;
    }
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    if (operationSignal.aborted) throw new ProviderTransportError(provider, 'PROVIDER_CANCELLED', 'request cancelled');
    if (error instanceof ProviderHttpError || error instanceof ProviderTransportError) throw error;
    // Do not retry an ambiguous failed POST: it may already have been billed.
    // Fetch exceptions may also contain URLs, headers, or nested credentials.
    throw new ProviderTransportError(provider, 'PROVIDER_TRANSPORT', 'request transport failed');
  } finally {
    clearTimeout(timer);
  }
}
