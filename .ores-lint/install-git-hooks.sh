#!/bin/sh
# Optional fallback installer. When tracked .githooks owns pre-push, that hook
# is the single integration point; do not create an inert .git/hooks copy.
set -eu
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo" >&2; exit 1; }
hooks_path=$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)
if [ -n "$hooks_path" ]; then
  if [ "$hooks_path" = ".githooks" ] && [ -f "$ROOT/.githooks/pre-push" ] && grep -Fq '.ores-lint/lint.sh' "$ROOT/.githooks/pre-push"; then
    echo "ores-lint is integrated by tracked .githooks/pre-push"
    exit 0
  fi
  active_hooks=$(git -C "$ROOT" rev-parse --git-path hooks)
  echo "refusing to write inert .git/hooks/pre-push while core.hooksPath=$hooks_path is active" >&2
  echo "integrate $ROOT/.ores-lint/lint.sh into $active_hooks/pre-push explicitly" >&2
  exit 1
fi
HOOK="$(git -C "$ROOT" rev-parse --absolute-git-dir)/hooks/pre-push"
mkdir -p "$(dirname "$HOOK")"
if [ -e "$HOOK" ] && ! grep -Fq 'installed by .ores-lint/install-git-hooks.sh' "$HOOK"; then
  echo "refusing to clobber an existing pre-push hook: $HOOK" >&2
  exit 1
fi
cat > "$HOOK" <<'INNER'
#!/bin/sh
# installed by .ores-lint/install-git-hooks.sh
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1
lint="$root/.ores-lint/lint.sh"
[ -f "$lint" ] || { echo "ores-lint entrypoint missing: $lint" >&2; exit 1; }
exec sh "$lint"
INNER
chmod +x "$HOOK"
echo "installed $HOOK"
