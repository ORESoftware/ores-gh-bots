import { MERGE_CONFIDENCE_THRESHOLD, MIN_OPEN_HOURS } from './config.ts';
import type { CheckRun, PullRequest, Review } from './github.ts';
import { hoursOpen } from './schedule.ts';

/**
 * Readiness is split into GATES and SIGNALS on purpose.
 *
 * A gate is binary and non-negotiable: fail one and the PR is not mergeable by
 * this job, no matter how good everything else looks. The 55-hour minimum is a
 * gate precisely because the original request called it critical — modelling it
 * as a weighted signal would let a very clean PR buy its way past the soak time.
 *
 * Signals are probabilistic and multiply into a confidence figure, which must
 * reach 99.5% before a merge is even considered.
 */

export interface ReadinessInput {
  readonly pr: PullRequest;
  readonly reviews: readonly Review[];
  readonly checks: readonly CheckRun[];
  readonly now: Date;
  /** Repos in this PR's disturbance set that moved after the PR last updated. */
  readonly disturbedBy: readonly string[];
  readonly requiredCheckNames?: readonly string[];
}

export interface GateResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface Readiness {
  readonly gates: readonly GateResult[];
  readonly blockedBy: readonly string[];
  readonly confidence: number;
  readonly signals: Readonly<Record<string, number>>;
  readonly mergeable: boolean;
  readonly recommendation: 'merge' | 'update' | 'hold' | 'escalate';
  readonly reason: string;
}

export function evaluate(input: ReadinessInput): Readiness {
  const { pr, reviews, checks, now, disturbedBy } = input;
  const age = hoursOpen(pr.created_at, now);

  const latestByReviewer = new Map<string, Review>();
  for (const r of reviews) {
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    const who = r.user?.login;
    if (!who) continue;
    latestByReviewer.set(who, r);
  }
  const verdicts = [...latestByReviewer.values()];
  const approvals = verdicts.filter((r) => r.state === 'APPROVED').length;
  const changesRequested = verdicts.filter((r) => r.state === 'CHANGES_REQUESTED').length;

  const completed = checks.filter((c) => c.status === 'completed');
  const failing = completed.filter(
    (c) => c.conclusion !== null && !['success', 'neutral', 'skipped'].includes(c.conclusion),
  );
  const pending = checks.filter((c) => c.status !== 'completed');
  const missingRequired = (input.requiredCheckNames ?? []).filter(
    (name) => !completed.some((c) => c.name === name && c.conclusion === 'success'),
  );

  const gates: GateResult[] = [
    {
      name: `open>=${MIN_OPEN_HOURS}h`,
      passed: age >= MIN_OPEN_HOURS,
      detail: `open ${age.toFixed(1)}h`,
    },
    { name: 'not-draft', passed: !pr.draft, detail: pr.draft ? 'PR is a draft' : 'ready for review' },
    {
      name: 'no-conflicts',
      // `mergeable` is null while GitHub is still computing it — unknown is not a pass.
      passed: pr.mergeable === true,
      detail: `mergeable=${String(pr.mergeable)} state=${pr.mergeable_state ?? 'unknown'}`,
    },
    { name: 'no-changes-requested', passed: changesRequested === 0, detail: `${changesRequested} requesting changes` },
    { name: 'checks-not-failing', passed: failing.length === 0, detail: `${failing.length} failing` },
    { name: 'checks-complete', passed: pending.length === 0, detail: `${pending.length} still running` },
    {
      name: 'required-checks-green',
      passed: missingRequired.length === 0,
      detail: missingRequired.length ? `missing ${missingRequired.join(', ')}` : 'all required green',
    },
    {
      name: 'no-hold-label',
      passed: !pr.labels.some((l) => /^(do-not-merge|hold|wip|blocked)$/i.test(l.name)),
      detail: pr.labels.map((l) => l.name).join(',') || 'no labels',
    },
    {
      name: 'undisturbed-by-deps',
      passed: disturbedBy.length === 0,
      detail: disturbedBy.length ? `moved: ${disturbedBy.join(', ')}` : 'dependency graph quiet',
    },
  ];

  const blockedBy = gates.filter((g) => !g.passed).map((g) => g.name);

  // Signals only shape confidence among PRs that already cleared every gate.
  // Each is 1.0 when the evidence is affirmative and drops when something is
  // merely *absent* rather than wrong — absence is doubt, not a blocker. Soak
  // deliberately does NOT appear here: it is a gate, and scoring it twice would
  // let a long-open PR compensate for missing review or CI evidence.
  const signals: Record<string, number> = {
    // Nobody approved. Not disqualifying on a solo fleet, but not 99.5% either.
    reviewed: approvals >= 1 ? 1 : 0.9,
    // No CI ran at all, so nothing positively demonstrated the change is sound.
    checkCoverage: completed.length >= 1 ? 1 : 0.7,
    // 'clean' is GitHub's own all-clear; 'unstable'/'blocked' mean something is
    // off even when no required check failed outright.
    freshBase: pr.mergeable_state === 'clean' ? 1 : 0.9,
  };
  const confidence = blockedBy.length
    ? 0
    : Object.values(signals).reduce((a, b) => a * b, 1);

  const mergeable = blockedBy.length === 0 && confidence >= MERGE_CONFIDENCE_THRESHOLD;
  const protectedFromAutomation = blockedBy.filter(
    (gate) => gate === 'not-draft' || gate === 'no-hold-label',
  );

  let recommendation: Readiness['recommendation'];
  let reason: string;
  if (mergeable) {
    recommendation = 'merge';
    reason = `all gates passed, confidence ${(confidence * 100).toFixed(2)}%`;
  } else if (protectedFromAutomation.length) {
    // Draft and explicitly held PRs are immutable to this unattended job. This
    // guard must precede both conflict escalation and update-branch handling.
    recommendation = 'hold';
    reason = `protected from automation by ${protectedFromAutomation.join(', ')}`;
  } else if (blockedBy.includes('no-conflicts')) {
    recommendation = 'escalate';
    reason = 'merge conflict — needs semantic resolution, never a side-pick';
  } else if (blockedBy.includes('undisturbed-by-deps') || pr.mergeable_state === 'behind') {
    recommendation = 'update';
    reason = disturbedBy.length
      ? `dependency movement in ${disturbedBy.join(', ')}`
      : 'branch is behind its base';
  } else if (blockedBy.length) {
    recommendation = 'hold';
    reason = `blocked by ${blockedBy.join(', ')}`;
  } else {
    recommendation = 'hold';
    reason = `confidence ${(confidence * 100).toFixed(2)}% below ${(MERGE_CONFIDENCE_THRESHOLD * 100).toFixed(1)}%`;
  }

  return { gates, blockedBy, confidence, signals, mergeable, recommendation, reason };
}
