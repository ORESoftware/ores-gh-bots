#!/usr/bin/env node
import { run, tally, type RepoOutcome } from './hygiene/run.ts';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string): string | null => {
  const i = args.indexOf(f);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

if (has('--help') || has('-h') || args.length === 0) {
  process.stdout.write(`fleet git hygiene — DEN-3956

Ensures every repo under a root ignores tmp/temp and tmp/worktrees, inside a
delimited managed block so the pass is safely repeatable.

Usage:
  node --experimental-strip-types src/hygiene-cli.ts --root <dir> [--apply] [--commit]

Flags:
  --root <dir>    required; the fleet checkout root
  --apply         write the changes (default: dry run, nothing is written)
  --commit        also commit .gitignore in each patched repo (implies --apply)
  --sink <dir>    park git lock files here when the filesystem forbids unlink
  --json          emit the full per-repo outcome list as JSON

Skipped by design: dd, dd-next-1, _to_delete, .worktrees, node_modules, target,
vendor, dist, build, and any repo nested inside another repo. Worktrees are
skipped because they share their parent checkout's .gitignore.
`);
  process.exit(0);
}

const root = val('--root');
if (!root) {
  process.stderr.write('--root is required\n');
  process.exit(2);
}

const commit = has('--commit');
const outcomes: RepoOutcome[] = run({
  root,
  apply: has('--apply') || commit,
  commit,
  cruftSink: val('--sink'),
});

const counts = tally(outcomes);
if (has('--json')) {
  process.stdout.write(JSON.stringify({ counts, outcomes }, null, 2) + '\n');
} else {
  for (const o of outcomes) {
    if (o.action === 'already-ok') continue;
    process.stdout.write(`${o.action.padEnd(18)} ${o.repo}  (${o.reason})\n`);
  }
}
process.stderr.write(
  `\n${outcomes.length} repos · ` +
    Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') + '\n',
);
process.exit(outcomes.some((o) => o.action === 'failed') ? 1 : 0);
