#!/usr/bin/env bash
# push-fleet.sh — push every local branch in the fleet to GitHub, safely.
#
# Run this on YOUR Mac, not inside Cowork. Cowork's sandboxes cannot reach
# GitHub for writes (an egress proxy allowlists repositories per session), and
# the desktop VM cannot reach it at all. Your own shell has real credentials and
# open network, so this is the shortest path from "committed" to "pushed".
#
#   bash scripts/push-fleet.sh                  # dry run, changes nothing
#   bash scripts/push-fleet.sh --apply          # actually push
#   bash scripts/push-fleet.sh --apply --tags   # also push local tags
#
# It will NEVER force-push, rebase, reset, stash, or delete a ref. A branch that
# has diverged from its remote is reported for a real merge, never overwritten.

set -uo pipefail

ROOT="${HOME}/codes"
APPLY=0
PUSH_TAGS=0
MAXDEPTH=3

# Not ours — upstream projects we happen to have clones of.
FOREIGN_OWNERS="rabbitmq gleam-lang"
# Excluded by standing request.
SKIP_DIRS="dd dd-next-1 dancing-dragons _to_delete .worktrees node_modules target vendor dist build Pods .venv venv"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --tags) PUSH_TAGS=1 ;;
    --root) ROOT="$2"; shift ;;
    --depth) MAXDEPTH="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="${ROOT}/push-report-${STAMP}.tsv"
DIVERGED="${ROOT}/push-diverged-${STAMP}.txt"
: > "$REPORT"; : > "$DIVERGED"
printf 'repo\tbranch\taction\tdetail\n' >> "$REPORT"

say() { printf '%s\n' "$*"; }
rec() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$REPORT"; }

skip_dir() {
  local base="$1"
  for s in $SKIP_DIRS; do [ "$base" = "$s" ] && return 0; done
  return 1
}

find_repos() {
  find "$ROOT" -maxdepth "$MAXDEPTH" -name .git -print0 2>/dev/null |
  while IFS= read -r -d '' g; do
    d=$(dirname "$g")
    skip=0
    # shellcheck disable=SC2086
    rest=${d#"$ROOT"/}
    IFS='/' read -ra parts <<< "$rest"
    for p in "${parts[@]}"; do skip_dir "$p" && { skip=1; break; }; done
    [ "$skip" -eq 0 ] && printf '%s\n' "$d"
  done
}

total_repos=0; pushed=0; newbr=0; diverged=0; uptodate=0; failed=0; skipped=0

while IFS= read -r repo; do
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || continue
  url=$(git -C "$repo" remote get-url origin 2>/dev/null) || { rec "$repo" "-" "no-remote" "no origin configured"; skipped=$((skipped+1)); continue; }
  owner=$(printf '%s' "$url" | sed 's#.*github.com[:/]##; s#/.*##')
  for f in $FOREIGN_OWNERS; do
    if [ "$owner" = "$f" ]; then
      rec "$repo" "-" "skipped-foreign" "$url"
      say "  skip (not ours): ${repo#$ROOT/}  -> $url"
      skipped=$((skipped+1)); continue 2
    fi
  done

  total_repos=$((total_repos+1))
  # Real remote state. Without this, "ahead/behind" is whatever was true at the
  # last fetch, which on these checkouts is badly stale.
  git -C "$repo" fetch --prune --quiet origin 2>/dev/null

  while IFS= read -r br; do
    [ -n "$br" ] || continue
    local_sha=$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$br") || continue
    remote_sha=$(git -C "$repo" rev-parse --verify --quiet "refs/remotes/origin/$br")

    if [ -z "$remote_sha" ]; then
      if [ "$APPLY" -eq 1 ]; then
        if err=$(git -C "$repo" push --set-upstream origin "refs/heads/$br:refs/heads/$br" 2>&1); then
          rec "$repo" "$br" "pushed-new" "created on origin"; newbr=$((newbr+1))
        else
          rec "$repo" "$br" "FAILED" "$(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)"; failed=$((failed+1))
        fi
      else
        rec "$repo" "$br" "would-push-new" "not on origin"; newbr=$((newbr+1))
      fi
      continue
    fi

    if [ "$local_sha" = "$remote_sha" ]; then
      rec "$repo" "$br" "up-to-date" ""; uptodate=$((uptodate+1)); continue
    fi

    if git -C "$repo" merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
      # Remote is an ancestor: a plain fast-forward, safe to push.
      if [ "$APPLY" -eq 1 ]; then
        if err=$(git -C "$repo" push origin "refs/heads/$br:refs/heads/$br" 2>&1); then
          rec "$repo" "$br" "pushed" "fast-forward"; pushed=$((pushed+1))
        else
          rec "$repo" "$br" "FAILED" "$(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)"; failed=$((failed+1))
        fi
      else
        ahead=$(git -C "$repo" rev-list --count "$remote_sha..$local_sha")
        rec "$repo" "$br" "would-push" "$ahead commit(s) ahead"; pushed=$((pushed+1))
      fi
      continue
    fi

    if git -C "$repo" merge-base --is-ancestor "$local_sha" "$remote_sha" 2>/dev/null; then
      rec "$repo" "$br" "behind" "remote ahead; nothing local to send"; uptodate=$((uptodate+1)); continue
    fi

    # Genuinely diverged. Do not force, do not merge blind — record it.
    a=$(git -C "$repo" rev-list --count "$remote_sha..$local_sha")
    b=$(git -C "$repo" rev-list --count "$local_sha..$remote_sha")
    rec "$repo" "$br" "DIVERGED" "local +$a / remote +$b — needs a semantic merge"
    printf '%s\t%s\tlocal+%s\tremote+%s\n' "${repo#$ROOT/}" "$br" "$a" "$b" >> "$DIVERGED"
    diverged=$((diverged+1))
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)

  if [ "$PUSH_TAGS" -eq 1 ] && [ "$APPLY" -eq 1 ]; then
    # --no-force is implicit; existing tags are never moved.
    git -C "$repo" push --tags origin >/dev/null 2>&1 && rec "$repo" "-" "tags-pushed" ""
  fi
done < <(find_repos)

say ""
say "================ fleet push summary ================"
say "  repos considered : $total_repos"
say "  skipped          : $skipped (foreign owner or no remote)"
if [ "$APPLY" -eq 1 ]; then
  say "  branches pushed  : $pushed"
  say "  new branches     : $newbr"
else
  say "  would push       : $pushed"
  say "  would create     : $newbr"
fi
say "  already current  : $uptodate"
say "  DIVERGED         : $diverged  <- need a real merge, nothing was forced"
say "  failed           : $failed"
say ""
say "  full report : $REPORT"
[ "$diverged" -gt 0 ] && say "  diverged list: $DIVERGED"
say ""
[ "$APPLY" -eq 0 ] && say "  This was a DRY RUN. Re-run with --apply to push."
exit 0
