import type { CheckRun, PullRequest, Review } from '../src/github.ts';

export const NOW = new Date('2026-08-23T06:00:00Z');

export function hoursAgo(h: number, from: Date = NOW): string {
  return new Date(from.getTime() - h * 3_600_000).toISOString();
}

export function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'test pr',
    draft: false,
    created_at: hoursAgo(60),
    updated_at: hoursAgo(1),
    head: { ref: 'feature', sha: 'aaa' },
    base: { ref: 'main', sha: 'bbb' },
    labels: [],
    user: { login: 'someone' },
    mergeable: true,
    mergeable_state: 'clean',
    ...over,
  };
}

export function approval(login = 'reviewer'): Review {
  return { state: 'APPROVED', user: { login }, submitted_at: hoursAgo(2) };
}

export function greenCheck(name = 'ci'): CheckRun {
  return { name, status: 'completed', conclusion: 'success' };
}
