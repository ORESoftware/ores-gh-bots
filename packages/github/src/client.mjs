import { setTimeout as sleep } from 'node:timers/promises';

export class GitHubHttpError extends Error {
  constructor(message, { status, body, headers, method, url, retryAfterMs = null }) {
    super(message);
    this.name = 'GitHubHttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.method = method;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(response, body) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Number(retryAfter) * 1000;
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset) return Math.max(1_000, Number(reset) * 1000 - Date.now());
  if (response.status === 403 && /secondary rate limit/i.test(JSON.stringify(body))) return 60_000;
  return null;
}

function linkNext(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

export class GitHubClient {
  constructor({ apiBaseUrl = 'https://api.github.com', apiVersion = '2026-03-10', userAgent = 'ores-gh-bots/0.1.0', fetchImpl = fetch } = {}) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.apiOrigin = new URL(this.apiBaseUrl).origin;
    this.apiVersion = apiVersion;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { token, body, headers = {}, accept = 'application/vnd.github+json', raw = false, retries = 2, signal } = {}) {
    const url = /^https?:\/\//.test(path) ? path : `${this.apiBaseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const parsedUrl = new URL(url);
    if (parsedUrl.origin !== this.apiOrigin) {
      throw new Error(`Refusing to send GitHub credentials to a different origin: ${parsedUrl.origin}`);
    }
    const requestHeaders = {
      accept,
      'user-agent': this.userAgent,
      'x-github-api-version': this.apiVersion,
      ...headers,
    };
    if (token) requestHeaders.authorization = `Bearer ${token}`;
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: requestHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (attempt < retries) {
          await sleep(Math.min(10_000, 500 * 2 ** attempt), undefined, { signal });
          continue;
        }
        throw error;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const responseBody = response.status === 204
        ? null
        : raw
          ? await response.text()
          : contentType.includes('json')
            ? await response.json().catch(() => null)
            : await response.text();

      if (response.ok) return { data: responseBody, headers: response.headers, status: response.status };

      const retryAfterMs = parseRetryAfter(response, responseBody);
      if (attempt < retries && (retryAfterMs !== null || [502, 503, 504].includes(response.status))) {
        await sleep(retryAfterMs ?? Math.min(10_000, 500 * 2 ** attempt), undefined, { signal });
        continue;
      }
      throw new GitHubHttpError(`GitHub ${method} ${url} failed with ${response.status}`, {
        status: response.status,
        body: responseBody,
        headers: response.headers,
        method,
        url,
        retryAfterMs,
      });
    }
  }

  async paginate(path, { token, map = (value) => value, maxPages = 100, signal } = {}) {
    const results = [];
    let next = path;
    for (let page = 0; next && page < maxPages; page += 1) {
      const response = await this.request('GET', next, { token, signal });
      const values = map(response.data);
      if (!Array.isArray(values)) throw new Error(`Pagination mapper did not return an array for ${next}`);
      results.push(...values);
      next = linkNext(response.headers.get('link'));
    }
    return results;
  }
}
