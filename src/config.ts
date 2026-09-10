/**
 * Fleet-wide configuration for the nightly PR reconciler.
 *
 * Source of truth: chat request #102 (Linear DEN-3946).
 *   - runs nightly at 1am America/Chicago
 *   - walks every PR in every repo across every org
 *   - updates PRs from their base and from dependency/dependent movement
 *   - auto-merges only what is more than 99.5% likely ready
 *   - auto-merged PRs must have been open at least 55 hours (hard requirement)
 */

export const SCHEDULE_TIMEZONE = 'America/Chicago';
export const SCHEDULE_HOUR = 1;

/**
 * Hard floor on how long a PR must have been open before this job is allowed to
 * merge it. Marked critical in the original request; treated as a gate, never a
 * weighted signal, so no amount of confidence elsewhere can buy past it.
 */
export const MIN_OPEN_HOURS = 55;

/**
 * Exclusive merge-confidence boundary. DEN-3946 says "more than 99.5%", so a
 * score of exactly 0.995 is intentionally not sufficient for unattended merge.
 */
export const MERGE_CONFIDENCE_THRESHOLD = 0.995;

/**
 * Current ORESoftware/my-ai/AGENTS.md requires at least 15 relevant commits of
 * history on both sides before a non-trivial conflict is resolved. We scale up
 * for entangled conflicts, but never below that policy floor.
 */
export const CONFLICT_CONTEXT_COMMITS_MIN = 15;
export const CONFLICT_CONTEXT_COMMITS_MAX = 30;

/** Orgs walked by the nightly pass. Extend as new orgs come online. */
export const FLEET_ORGS: readonly string[] = [
  'ORESoftware',
  'oresoftware-test',
  'sonus-auris',
  'sonus-auris-test',
  'zed-pkg',
  'zed-pkg-test',
  'fiducia-cloud',
  'fiducia-cloud-test',
  'memebank',
  'memebank-test',
  'cliptown',
  'cliptown-test',
  'shared-auth',
  'shared-auth-test',
  'opto-sync',
  'opto-sync-test',
  'messaging-intel',
  'messaging-intel-test',
  'benefactor-cc',
  'canonical-cloud',
  'canonical-cloud-test',
  'quaestor-ledger',
  'quaestor-ledger-test',
  'file-tunnel',
  'file-tunnel-test',
  'flags-2-env',
  'flags-2-env-test',
  'gha-indie-worker',
  'declarative-migrations',
  'declarative-migrations-test',
  'discrete-event-systems',
  'discrete-event-systems-test',
  'embedded-alerts',
  'embedded-alerts-test',
  'evento-globolo',
  'evento-globolo-test',
  'hacker-house-medellin',
  'hacker-house-medellin-test',
  'apostille-me',
  'apostille-me-test',
  'elenkos-systems',
  'elenkos-systems-test',
  'praxonne',
  'praxonne-test',
  'ores-otel',
  'ores-otel-test',
  'ores-uni-threads',
  'streempilot',
  'streempilot-test',
  'happy-wakey',
  'happy-wakey-test',
  'networking-components',
  'networking-components-test',
  'scintilla-run',
  'scintilla-run-test',
  'fanwaave',
  '22-factor-apps',
];

/**
 * Repos the job must never touch, even when it can see them.
 * `dd` is excluded from all automated agent work per chat request #89.
 */
export const EXCLUDED_REPOS: readonly string[] = ['ORESoftware/dd', 'ORESoftware/dd-next-1'];

export interface ReconcileOptions {
  readonly dryRun: boolean;
  readonly orgs: readonly string[];
  readonly repoFilter: string | null;
  readonly ignoreSchedule: boolean;
  readonly maxReposPerOrg: number | null;
}

export const DEFAULT_OPTIONS: ReconcileOptions = {
  dryRun: true,
  orgs: FLEET_ORGS,
  repoFilter: null,
  ignoreSchedule: false,
  maxReposPerOrg: null,
};
