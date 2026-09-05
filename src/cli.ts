#!/usr/bin/env node
import { DEFAULT_OPTIONS, FLEET_ORGS, SCHEDULE_TIMEZONE, type ReconcileOptions } from './config.ts';
import { GitHubClient } from './github.ts';
import { reconcile, summarise } from './reconcile.ts';
import { isScheduledHour, localHourIn } from './schedule.ts';
import { log } from './log.ts';

function parseArgs(argv: readonly string[]): ReconcileOptions & { help: boolean } {
  let opts: ReconcileOptions = { ...DEFAULT_OPTIONS };
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--apply':
        opts = { ...opts, dryRun: false };
        break;
      case '--dry-run':
        opts = { ...opts, dryRun: true };
        break;
      case '--ignore-schedule':
        opts = { ...opts, ignoreSchedule: true };
        break;
      case '--org': {
        const v = argv[++i];
        if (v) opts = { ...opts, orgs: v.split(',').map((s) => s.trim()).filter(Boolean) };
        break;
      }
      case '--repo': {
        const v = argv[++i];
        if (v) opts = { ...opts, repoFilter: v };
        break;
      }
      case '--max-repos': {
        const v = argv[++i];
        if (v) opts = { ...opts, maxReposPerOrg: Number(v) };
        break;
      }
      default:
        if (a && a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return { ...opts, help };
}

const USAGE = `ores-gh-bots — nightly cross-org PR reconciliation

Usage:
  node --experimental-strip-types src/cli.ts [flags]

Flags:
  --apply              perform merges/updates/comments (default is dry run)
  --dry-run            report only, change nothing (default)
  --org a,b,c          limit to these orgs (default: all ${FLEET_ORGS.length} fleet orgs)
  --repo <substring>   limit to repos whose name contains this
  --max-repos <n>      cap repos examined per org (useful for smoke runs)
  --ignore-schedule    run even when it is not 1am ${SCHEDULE_TIMEZONE}
  -h, --help           this text

Environment:
  GITHUB_TOKEN / GH_TOKEN   required
  LOG_LEVEL                 debug | info | warn | error (default info)

Safety: dry run is the default. Nothing is merged unless --apply is passed AND
the PR has been open at least 55 hours AND every gate passes at >=99.5%
confidence. Conflicts are never auto-resolved — see docs/policy.md.`;

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  const now = new Date();
  if (!opts.ignoreSchedule && !isScheduledHour(now)) {
    log.info('not the scheduled hour, exiting cleanly', {
      localHour: localHourIn(SCHEDULE_TIMEZONE, now),
      tz: SCHEDULE_TIMEZONE,
    });
    return 0;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token) {
    log.error('missing GITHUB_TOKEN / GH_TOKEN');
    return 2;
  }

  const gh = new GitHubClient(token);
  const report = await reconcile(gh, opts, now);
  process.stdout.write(JSON.stringify({ report }, null, 2) + '\n');
  process.stderr.write(summarise(report) + '\n');
  return report.outcomes.some((o) => o.action === 'failed') ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log.error('fatal', { err: err instanceof Error ? err.stack : String(err) });
    process.exit(3);
  },
);
