#!/bin/bash
# Snapshot the mirrors, run the real push, then assert exactly what changed.
set -u
cd /home/claude/testorg || exit 1
M=/home/claude/testorg/mirrors

snap() { # $1 label
  for g in "$M"/*.git; do
    n=$(basename "$g" .git)
    git --git-dir="$g" for-each-ref --format="$n %(refname) %(objectname)" refs/heads
  done | sort > "/tmp/snap_$1.txt"
}

snap before
before_diverged=$(git --git-dir="$M/opto-sync-test~contract-conformance-tests.git" rev-parse refs/heads/main)

bash /home/claude/work/ores-gh-bots/scripts/push-fleet.sh --root /home/claude/testorg/fleet --apply 2>&1 | tail -12

snap after
after_diverged=$(git --git-dir="$M/opto-sync-test~contract-conformance-tests.git" rev-parse refs/heads/main)

echo
echo "================ assertions ================"
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1 (got '$2' want '$3')"; fail=$((fail+1)); fi; }

# 1. The diverged mirror must be untouched — this is the whole safety property.
chk "diverged mirror untouched (no force)" "$after_diverged" "$before_diverged"

# 2. The fast-forward must have landed.
ff_local=$(git -C fleet/orgA/ff rev-parse main)
ff_mirror=$(git --git-dir="$M/sonus-auris-test~chaos-recovery-tests.git" rev-parse refs/heads/main)
chk "fast-forward landed on mirror" "$ff_mirror" "$ff_local"

# 3. The slash-named branch must exist on the mirror at the right sha.
nb_local=$(git -C fleet/orgA/newbranch rev-parse "agent/den-9999-write-probe")
nb_mirror=$(git --git-dir="$M/cliptown-test~clients-rust-consumer.git" rev-parse "refs/heads/agent/den-9999-write-probe" 2>/dev/null || echo MISSING)
chk "slash-named branch created correctly" "$nb_mirror" "$nb_local"

# 4. Upstream tracking must be set for the new branch.
up=$(git -C fleet/orgA/newbranch rev-parse --abbrev-ref "agent/den-9999-write-probe@{upstream}" 2>/dev/null || echo NONE)
chk "upstream set on new branch" "$up" "origin/agent/den-9999-write-probe"

# 5. Nothing may have been pushed to the foreign remote's mirror (there is none).
chk "foreign repo produced no mirror write" "$(ls "$M" | grep -c rabbitmq)" "0"

# 6. The behind repo's mirror must not have been rewound.
beh=$(git --git-dir="$M/declarative-migrations-test~schema-drift-detection.git" rev-parse refs/heads/main)
beh_local=$(git -C fleet/orgA/behind rev-parse main)
if [ "$beh" != "$beh_local" ]; then echo "  PASS  behind repo left alone (mirror still ahead)"; pass=$((pass+1));
else echo "  FAIL  behind repo mirror was rewound to local"; fail=$((fail+1)); fi

# 7. Exactly the expected refs changed, nothing else.
changed=$(diff /tmp/snap_before.txt /tmp/snap_after.txt | grep -c '^[<>]')
echo "  ..    ref lines differing before/after: $changed"
diff /tmp/snap_before.txt /tmp/snap_after.txt | grep '^[<>]' | sed 's/^/      /'

echo
echo "  passed=$pass failed=$fail"
