export const CHECK_NAMES = Object.freeze({
  openai: 'ores-review/openai',
  claude: 'ores-review/claude',
  gate: 'ores-review/gate',
});

export const PROVIDERS = Object.freeze(['openai', 'claude']);
export const OWN_CHECK_NAMES = new Set(Object.values(CHECK_NAMES));

export const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'edited',
]);

export const REVIEW_VERDICTS = new Set(['approve', 'comment', 'request_changes']);
export const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);

export const DEFAULTS = Object.freeze({
  githubApiBaseUrl: 'https://api.github.com',
  githubApiVersion: '2026-03-10',
  port: 8080,
  bodyLimitBytes: 2_000_000,
  maxDiffBytes: 500_000,
  maxFileBytes: 80_000,
  maxFiles: 200,
  maxFindings: 30,
  reviewTimeoutMs: 180_000,
  queuePath: './data/ores-gh-bots.sqlite',
  queuePollMs: 750,
  queueLeaseMs: 300_000,
  queueMaxAttempts: 8,
  reconcileIntervalMs: 600_000,
  reconcileMaxRepos: 2_000,
  reconcileMaxPrsPerRepo: 100,
  workerConcurrency: 2,
});
