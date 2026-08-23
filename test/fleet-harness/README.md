# Fleet push harness

Exercises `scripts/push-fleet.sh` against **real `*-test` org histories** rather
than synthetic fixtures. Each repo is a working clone whose `origin` is a local
bare mirror of the actual GitHub repo, so branch names, merge shapes and history
depth are real. Mirrors stand in for the remotes because the git proxy denies
writes to every org, including the `*-test` ones — reads are allowed, so the
histories are genuine even though the pushes land locally.

```bash
bash test/fleet-harness/build_fleet.sh    # six real repos -> the four branch states + edge cases
bash test/fleet-harness/verify_apply.sh   # push for real, then assert what changed
bash test/fleet-harness/adversarial.sh    # the cases that can cause damage
```

`verify_apply.sh` snapshots every mirror ref before and after and asserts that
**exactly** the intended refs moved. That whole-fleet diff is the assertion that
matters: it catches damage the per-repo checks would miss.

## What the harness found

Synthetic fixtures passed everything. Real histories did not:

- **Branch resurrection.** A branch deleted upstream by a merge-and-delete reaper
  still has `branch.<name>.merge` configured locally. It was classified
  `would-push-new` and would have been re-created — every merged branch, on
  every run, fleet-wide. Now reported as `upstream-deleted` and left alone. The
  distinction is a *configured upstream*: a branch that never had one is
  genuinely new and still pushes.
- **Decisions on stale data.** A failed `git fetch` was ignored, so an
  unreachable remote produced a confident `would-push` derived from week-old
  tracking refs. Now the repo is skipped as `fetch-failed`.
- **Silent omission.** A repo with no commits produced no report row at all.
  Reported as `empty-repo`; a repo that vanishes from a fleet report is the same
  class of failure as a traversal that never looked.

Also covered, and correct from the start: branch names containing slashes
(`agent/DEN-1298-…`, the fleet's convention), a branch named
`feature/--not-a-flag`, a repo with 153 branches, detached HEAD, a
submodule-shaped repo whose `.git` is a file, no configured origin, and a
foreign-owner remote that must never be written to.
