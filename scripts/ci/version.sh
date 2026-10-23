#!/usr/bin/env bash
# Derives the version, MAJOR.MINOR.<commit count> (https://standards.thmsn.dev/d/versioning), and
# prints RELEASE_VERSION, COMMIT and DIRTY as shell assignments: `eval "$(scripts/ci/version.sh)"`.
# A RELEASE_VERSION already in the environment wins, so CI computes it once and passes it down.
# Refuses a shallow clone and a missing tag rather than guessing; VERSION_UNTAGGED_OK=1 allows
# 0.0 for a repo that has never been tagged.
set -eu
if [ -n "${RELEASE_VERSION:-}" ]; then
  printf 'RELEASE_VERSION=%s\n' "$RELEASE_VERSION"
else
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "shallow clone: the commit count would be too low" >&2; exit 1
  fi
  git fetch --tags --quiet origin 2>/dev/null || true
  mm() { sed -n 's/^v\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p'; }
  MM="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null | mm)"
  [ -n "$MM" ] || MM="$(git tag -l | mm | sort -k1,1n -k2,2n | tail -n 1)"
  if [ -z "$MM" ]; then
    [ "${VERSION_UNTAGGED_OK:-}" = 1 ] || { echo "no vMAJOR.MINOR tag (tag fetch failed?)" >&2; exit 1; }
    MM="0 0"
  fi
  set -- $MM
  printf 'RELEASE_VERSION=%s.%s.%s\n' "$1" "$2" "$(git rev-list --count HEAD)"
fi
printf 'COMMIT=%s\n' "$(git rev-parse --short=7 HEAD)"
[ -z "$(git status --porcelain --untracked-files=no)" ] && echo DIRTY=false || echo DIRTY=true
