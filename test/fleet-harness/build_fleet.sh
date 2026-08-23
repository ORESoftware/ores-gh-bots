#!/bin/bash
# Build a test fleet from REAL *-test org histories.
#
# Each repo is a working clone whose origin is a local bare mirror of the actual
# GitHub repo, so branch names, merge shapes and history depth are real. The
# mirrors stand in for the remotes because the git proxy denies writes to every
# org, including the *-test ones.
set -u
cd /home/claude/testorg || exit 1
M="/home/claude/testorg/mirrors"
rm -rf fleet && mkdir -p fleet/orgA fleet/orgB

clone() { # $1 mirror slug, $2 dest
  git clone -q "$M/$1.git" "$2" 2>/dev/null || return 1
  git -C "$2" config user.email t@t
  git -C "$2" config user.name "Test"
}

# 1. FAST-FORWARD: local ahead of the mirror by one real-looking commit.
clone "sonus-auris-test~chaos-recovery-tests" fleet/orgA/ff
echo "local change" >> fleet/orgA/ff/README.md 2>/dev/null || echo x > fleet/orgA/ff/local.txt
git -C fleet/orgA/ff add -A && git -C fleet/orgA/ff commit -qm "local: fast-forward candidate"

# 2. DIVERGED: both sides move.
clone "opto-sync-test~contract-conformance-tests" fleet/orgA/diverged
echo "local side" > fleet/orgA/diverged/local-side.txt
git -C fleet/orgA/diverged add -A && git -C fleet/orgA/diverged commit -qm "local: diverging commit"
# advance the mirror independently
rm -rf /tmp/mirroradv && git clone -q "$M/opto-sync-test~contract-conformance-tests.git" /tmp/mirroradv
git -C /tmp/mirroradv config user.email o@o; git -C /tmp/mirroradv config user.name Other
echo "remote side" > /tmp/mirroradv/remote-side.txt
git -C /tmp/mirroradv add -A && git -C /tmp/mirroradv commit -qm "remote: diverging commit"
git -C /tmp/mirroradv push -q origin HEAD

# 3. NEW BRANCH with a slash in the name — the fleet's real convention.
clone "cliptown-test~clients-rust-consumer" fleet/orgA/newbranch
git -C fleet/orgA/newbranch checkout -q -b agent/den-9999-write-probe
echo new > fleet/orgA/newbranch/feature.txt
git -C fleet/orgA/newbranch add -A && git -C fleet/orgA/newbranch commit -qm "local: new branch with slash in name"

# 4. BEHIND: mirror moves, local does not.
clone "declarative-migrations-test~schema-drift-detection" fleet/orgA/behind
rm -rf /tmp/behindadv && git clone -q "$M/declarative-migrations-test~schema-drift-detection.git" /tmp/behindadv
git -C /tmp/behindadv config user.email o@o; git -C /tmp/behindadv config user.name Other
echo ahead > /tmp/behindadv/remote-only.txt
git -C /tmp/behindadv add -A && git -C /tmp/behindadv commit -qm "remote: moved ahead"
git -C /tmp/behindadv push -q origin HEAD

# 5. UP TO DATE, untouched.
clone "3fa-app-test~.github" fleet/orgA/uptodate

# 6. MANY BRANCHES (153, slash-heavy) — refspec and throughput.
clone "zed-pkg-test~zed-pkg-e2e" fleet/orgB/manybranches

# --- edge cases the synthetic fixtures never covered ---

# 7. DETACHED HEAD.
clone "cliptown-test~clients-rust-consumer" fleet/orgB/detached
git -C fleet/orgB/detached checkout -q --detach HEAD

# 8. No origin remote at all.
mkdir -p fleet/orgB/noremote && git init -q -b main fleet/orgB/noremote
git -C fleet/orgB/noremote config user.email t@t; git -C fleet/orgB/noremote config user.name T
echo x > fleet/orgB/noremote/a.txt
git -C fleet/orgB/noremote add -A && git -C fleet/orgB/noremote commit -qm init

# 9. Submodule-shaped: .git is a FILE, not a directory.
clone "cliptown-test~clients-rust-consumer" fleet/orgB/submodulish
mv fleet/orgB/submodulish/.git fleet/orgB/realgitdir
echo "gitdir: ../realgitdir" > fleet/orgB/submodulish/.git
git -C fleet/orgB/submodulish status --porcelain >/dev/null 2>&1 && echo "  submodule-shaped repo is functional"

# 10. Foreign owner that must never be pushed to.
mkdir -p fleet/orgB/foreign && git init -q -b main fleet/orgB/foreign
git -C fleet/orgB/foreign config user.email t@t; git -C fleet/orgB/foreign config user.name T
echo x > fleet/orgB/foreign/a.txt
git -C fleet/orgB/foreign add -A && git -C fleet/orgB/foreign commit -qm init
git -C fleet/orgB/foreign remote add origin https://github.com/rabbitmq/amqp091-go.git

echo "--- fleet built ---"
for d in fleet/*/*; do
  [ -e "$d/.git" ] || continue
  b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)
  n=$(git -C "$d" for-each-ref --format=x refs/heads 2>/dev/null | wc -l)
  printf '  %-26s HEAD=%-28s branches=%s\n' "${d#fleet/}" "$b" "$n"
done
