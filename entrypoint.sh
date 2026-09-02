#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'entrypoint: no command supplied' >&2
  exit 64
fi

printf '%s' 'entrypoint: executing' >&2
for argument do
  printf ' <%s>' "$argument" >&2
done
printf ' ....\n' >&2

exec "$@"
