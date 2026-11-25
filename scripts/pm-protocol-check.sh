#!/usr/bin/env bash
# t3code-pm: fails when the fork's orchestration protocol differs from upstream's at the merge base.
# The official T3 Code apps refuse a server on another protocol, so a mismatch locks them out.
#
#   scripts/pm-protocol-check.sh [<upstream ref>]   # default: the merge base with origin/main
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

file=packages/contracts/src/environment.ts
base="$(git merge-base HEAD "${1:-origin/main}")"
pattern='^export const ORCHESTRATION_PROTOCOL_VERSION(_TEXT)? = '
ours="$(grep -E "$pattern" "$file")"
theirs="$(git show "$base:$file" | grep -E "$pattern")"
if [[ "$ours" != "$theirs" ]]; then
  echo "pm-protocol-check: $file differs from upstream at $(git rev-parse --short "$base"):" >&2
  diff <(echo "$theirs") <(echo "$ours") >&2 || true
  echo "Keep upstream's protocol, or the official apps cannot connect to PM3code." >&2
  exit 1
fi
echo "pm-protocol-check: orchestration protocol matches upstream ($(echo "$ours" | head -1 | sed 's/.*= //;s/;//'))"
