#!/bin/bash
# Cases that could plausibly make a fleet push do damage.
set -u
cd /home/claude/testorg || exit 1
M=/home/claude/testorg/mirrors
rm -rf adv && mkdir -p adv/orgA

clone() { git clone -q "$M/$1.git" "$2" 2>/dev/null; git -C "$2" config user.email t@t; git -C "$2" config user.name T; }

# A. DELETED-UPSTREAM: a branch that exists locally with tracking, which someone
#    deliberately deleted on the remote (exactly what a merge-and-delete reaper
#    does). Re-creating it would resurrect merged/abandoned branches fleet-wide.
clone "cliptown-test~clients-rust-consumer" adv/orgA/deleted-upstream
git -C adv/orgA/deleted-upstream checkout -q -b agent/den-8888-was-merged
echo x > adv/orgA/deleted-upstream/f.txt
git -C adv/orgA/deleted-upstream add -A
git -C adv/orgA/deleted-upstream commit -qm "work that was merged upstream"
git -C adv/orgA/deleted-upstream push -q --set-upstream origin agent/den-8888-was-merged
# remote deletes it (reaper merged and cleaned up)
git --git-dir="$M/cliptown-test~clients-rust-consumer.git" update-ref -d refs/heads/agent/den-8888-was-merged
echo "  A. remote branch deleted; local still tracks it"

# B. UNREACHABLE REMOTE: fetch must fail and the push must not proceed on stale data.
clone "opto-sync-test~contract-conformance-tests" adv/orgA/unreachable
git -C adv/orgA/unreachable remote set-url origin /home/claude/testorg/mirrors/does-not-exist.git
echo y > adv/orgA/unreachable/g.txt
git -C adv/orgA/unreachable add -A && git -C adv/orgA/unreachable commit -qm "local work behind a dead remote"
echo "  B. origin points at a nonexistent path"

# C. EMPTY REPO: initialised, no commits, has an origin.
mkdir -p adv/orgA/empty && git init -q -b main adv/orgA/empty
git -C adv/orgA/empty remote add origin "$M/3fa-app-test~.github.git"
echo "  C. repo with zero commits"

# D. WEIRD BRANCH NAME that could be read as an option.
clone "sonus-auris-test~chaos-recovery-tests" adv/orgA/weirdname
git -C adv/orgA/weirdname checkout -q -b "feature/--not-a-flag"
echo z > adv/orgA/weirdname/h.txt
git -C adv/orgA/weirdname add -A && git -C adv/orgA/weirdname commit -qm "branch name that looks like a flag"
echo "  D. branch named feature/--not-a-flag"

echo "--- built ---"
