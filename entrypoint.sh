#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'entrypoint: no command supplied' >&2
  exit 64
fi

# Do not emit argv values: overridden commands may carry credentials or other
# sensitive material. The argument count is sufficient for a bounded startup
# diagnostic while preserving exact process and signal semantics.
printf 'entrypoint: executing command with %s argument(s)\n' "$#" >&2

exec "$@"
