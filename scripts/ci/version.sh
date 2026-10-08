#!/usr/bin/env bash
# Prints the derived version, MAJOR.MINOR.<commit count> (standards/docs/versioning.md).
# RELEASE_VERSION in the environment wins, so CI can compute it once and pass it down.
set -euo pipefail
if [ -n "${RELEASE_VERSION:-}" ]; then printf '%s\n' "$RELEASE_VERSION"; exit 0; fi
if ! git rev-parse --git-dir >/dev/null 2>&1; then echo 0.0.0; exit 0; fi
COUNT="$(git rev-list --count HEAD)"
TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
MM="$(printf '%s' "${TAG#v}" | awk -F. '{ if ($1 != "" && $2 != "") print $1"."$2 }')"
[ -n "$MM" ] || MM="0.0"
printf '%s\n' "$MM.$COUNT"
