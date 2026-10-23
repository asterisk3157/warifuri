#!/usr/bin/env bash
# Stops a commit that would publish a word from the maintainer's private list
# (names, domains, paths, work areas). The list is never committed: it is read from
# $WARIFURI_PRIVATE_TERMS, or from .private-terms.txt at the repository root
# (ignored by git). One extended regular expression per line, matched without regard
# to case; empty lines and lines starting with # are skipped.
#
# Usage: scripts/check-private-terms.sh          check the staged changes (pre-commit)
#        scripts/check-private-terms.sh --all    check every tracked file
# Without a list it says so and passes, so that contributors can commit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

list="${WARIFURI_PRIVATE_TERMS:-.private-terms.txt}"
if [ ! -r "$list" ]; then
  echo "check-private-terms: no list at $list, skipped" >&2
  exit 0
fi
patterns="$(mktemp)"
trap 'rm -f "$patterns"' EXIT
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list" > "$patterns" || true
[ -s "$patterns" ] || exit 0

if [ "${1:-}" = "--all" ]; then
  found="$(git grep -n -I -i -E -f "$patterns" -- . ':!.private-terms.txt' || true)"
else
  # Only the lines this commit adds.
  found="$(git diff --cached -U0 --no-color -- . ':!.private-terms.txt' \
    | awk '/^\+\+\+ /{f=substr($0,7)} /^\+[^+]/{print f": "substr($0,2)}' \
    | grep -i -E -f "$patterns" || true)"
fi

if [ -n "$found" ]; then
  echo "check-private-terms: private words found; nothing was committed:" >&2
  echo "$found" >&2
  exit 1
fi
