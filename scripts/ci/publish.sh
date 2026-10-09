#!/usr/bin/env bash
# Publishes the packaged .vsix for the current derived version to the Visual Studio
# Marketplace. vsce reads the token from VSCE_PAT; it never goes on the command line.
# Re-running for a version that's already published is a no-op (--skip-duplicate).
set -euo pipefail
version="$(scripts/ci/version.sh)"
vsix="apim-policy-${version}.vsix"
if [ ! -f "$vsix" ]; then
  echo "error: $vsix not found; run npm run package first" >&2
  exit 1
fi
if [ -z "${VSCE_PAT:-}" ]; then
  echo "error: VSCE_PAT is empty; set the vsce_pat secret in Woodpecker" >&2
  exit 1
fi
npx vsce publish --packagePath "$vsix" --skip-duplicate
echo "published $(node -p "require('./package.json').publisher").apim-policy@${version}"
