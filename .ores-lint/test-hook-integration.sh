#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fail() {
  echo "ores-lint hook integration: $*" >&2
  exit 1
}

# The tracked hook remains the authority when .githooks is active. Accept the
# direct `zed validate` form or the reviewed `$zed_bin validate` wrapper, but
# comments alone do not count as evidence.
if ! grep -Ev '^[[:space:]]*#' "$ROOT/.githooks/pre-push" | grep -Eq '(^|[[:space:]"'"'])(zed|\$\{?zed_bin\}?|\$\{?ZED_BIN\}?)(["'"']?)[[:space:]]+validate([[:space:]]|$)'; then
  fail "tracked hook lost executable zed validation"
fi
grep -Fq 'conformance/check.sh --full' "$ROOT/.githooks/pre-push" || fail "tracked hook lost full conformance"
grep -Fq '.ores-lint/lint.sh' "$ROOT/.githooks/pre-push" || fail "tracked hook does not invoke ores-lint"

new_repo() {
  name=$1
  repo="$TMP/$name"
  git init -q "$repo"
  mkdir -p "$repo/.ores-lint" "$repo/.githooks"
  cp "$ROOT/.ores-lint/install-git-hooks.sh" "$repo/.ores-lint/install-git-hooks.sh"
  cp "$ROOT/.githooks/pre-push" "$repo/.githooks/pre-push"
  cat > "$repo/.ores-lint/lint.sh" <<'LINT'
#!/bin/sh
set -eu
printf '%s\n' ran > .ores-lint/lint-ran
LINT
  chmod +x "$repo/.ores-lint/lint.sh" "$repo/.githooks/pre-push"
  printf '%s\n' "$repo"
}

# Active .githooks must be recognized, not shadowed by .git/hooks.
repo=$(new_repo tracked)
git -C "$repo" config core.hooksPath .githooks
(cd "$repo" && sh .ores-lint/install-git-hooks.sh)
default_hook="$(git -C "$repo" rev-parse --absolute-git-dir)/hooks/pre-push"
[ ! -e "$default_hook" ] || fail "installer wrote an inert default hook while .githooks was active"

# A different owner is preserved and requires explicit integration.
repo=$(new_repo custom)
git -C "$repo" config core.hooksPath custom-hooks
if (cd "$repo" && sh .ores-lint/install-git-hooks.sh) >"$TMP/custom.out" 2>&1; then
  fail "installer accepted an unrelated custom hooksPath"
fi
grep -Fq 'refusing to write inert' "$TMP/custom.out" || fail "custom ownership refusal was not explicit"
[ ! -e "$(git -C "$repo" rev-parse --absolute-git-dir)/hooks/pre-push" ] || fail "custom ownership created an inert default hook"

# With no configured hooksPath, the optional fallback remains usable.
repo=$(new_repo fallback)
(cd "$repo" && sh .ores-lint/install-git-hooks.sh)
hook="$(git -C "$repo" rev-parse --absolute-git-dir)/hooks/pre-push"
[ -x "$hook" ] || fail "fallback pre-push hook was not installed"
(cd "$repo" && "$hook")
[ -f "$repo/.ores-lint/lint-ran" ] || fail "fallback hook did not execute ores-lint"

printf '%s\n' 'ores-lint hook integration: PASS'
