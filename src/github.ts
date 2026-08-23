import { log } from './log.ts';

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly draft: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly user: { readonly login: string } | null;
  /** Only present on the single-PR endpoint, not on list responses. */
  readonly mergeable?: boolean | null;
  readonly mergeable_state?: string;
  readonly rebaseable?: boolean | null;
}

export interface Review {
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  readonly user: { readonly login: string } | null;
  readonly submitted_at: string | null;
}

export interface CheckRun {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion: string | null;
}

export interface Repo {
  readonly name: string;
  readonly full_name: string;
  readonly archived: boolean;
  readonly default_branch: string;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message: string) {
    super(`${status} ${url} — ${message}`);
    this.name = 'GitHubError';
    this.status = status;
    this.url = url;
  }
}

const API = 'https://api.github.com';

export class GitHubClient {
  #token: string;
  #calls = 0;

  constructor(token: string) {
    if (!token) throw new Error('GitHubClient requires a token (GITHUB_TOKEN / GH_TOKEN)');
    this.#token = token;
  }

  get callCount(): number {
    return this.#calls;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.#calls++;
      const res = await fetch(url, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.#token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ores-gh-bots/0.1',
          ...(init.headers ?? {}),
        },
      });

      // Secondary rate limit / abuse detection: back off and retry.
      if (res.status === 403 || res.status === 429) {
        const remaining = res.headers.get('x-ratelimit-remaining');
        const retryAfter = Number(res.headers.get('retry-after') ?? 0);
        if (remaining === '0' || retryAfter > 0) {
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 5_000;
          log.warn('rate limited, backing off', { url, waitMs, attempt });
          await sleep(waitMs);
          continue;
        }
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2 ** attempt * 1_000);
        continue;
      }
      if (!res.ok) {
        throw new GitHubError(res.status, url, (await res.text()).slice(0, 400));
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    throw new GitHubError(429, url, 'exhausted retries');
  }

  /** Follows RFC 5988 `link` headers to the end. */
  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path.startsWith('http') ? path : `${API}${path}`;
    while (url) {
      this.#calls++;
      const res: Response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.#token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ores-gh-bots/0.1',
        },
      });
      if (!res.ok) throw new GitHubError(res.status, url, (await res.text()).slice(0, 400));
      out.push(...((await res.json()) as T[]));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }

  listOrgRepos(org: string): Promise<Repo[]> {
    return this.paginate<Repo>(`/orgs/${org}/repos?per_page=100&type=all&sort=pushed`);
  }

  listOpenPulls(owner: string, repo: string): Promise<PullRequest[]> {
    return this.paginate<PullRequest>(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
  }

  /** The list endpoint omits `mergeable`; GitHub computes it lazily per PR. */
  getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${owner}/${repo}/pulls/${number}`);
  }

  listReviews(owner: string, repo: string, number: number): Promise<Review[]> {
    return this.paginate<Review>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);
  }

  async listCheckRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]> {
    const body = await this.request<{ check_runs: CheckRun[] }>(
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    );
    return body.check_runs ?? [];
  }

  listPullFiles(owner: string, repo: string, number: number): Promise<Array<{ filename: string }>> {
    return this.paginate<{ filename: string }>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
  }

  /** Fast-forwards a PR branch onto its base. Returns false when GitHub reports a conflict. */
  async updateBranch(owner: string, repo: string, number: number, expectedHeadSha: string): Promise<boolean> {
    try {
      await this.request(`/repos/${owner}/${repo}/pulls/${number}/update-branch`, {
        method: 'PUT',
        body: JSON.stringify({ expected_head_sha: expectedHeadSha }),
        headers: { 'content-type': 'application/json' },
      });
      return true;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 422 || err.status === 409)) return false;
      throw err;
    }
  }

  async merge(owner: string, repo: string, number: number, sha: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ sha, merge_method: 'merge' }),
      headers: { 'content-type': 'application/json' },
    });
  }

  async comment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
      headers: { 'content-type': 'application/json' },
    });
  }

  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/${number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Raw file contents at a ref, or null when absent. */
  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      const body = await this.request<{ content?: string; encoding?: string }>(
        `/repos/${owner}/${repo}/contents/${path}${q}`,
      );
      if (!body.content) return null;
      return Buffer.from(body.content, (body.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }
}

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
