#!/usr/bin/env bash
# Let'sMap! — Mac build + upload to the existing GitHub release (arm64)
# Run on macOS. Requires: node/npm, gh CLI (brew install gh; gh auth login).
#
# v0.3.0+: the analysis engine is pure JS and ships inside the app —
# no Python/PyInstaller step anymore. The release tag is created from the
# Windows side; this script only builds the .dmg and uploads it.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
REPO="MiguelAngGar/Let-sMap-"

echo ">> Version: ${VERSION}  Tag: ${TAG}"

# Sanity: build exactly what was tagged
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!! Working tree not clean — commit or stash first." >&2
  exit 1
fi

# 1. Build mac arm64 dmg -> dist/mac/
echo ">> electron-builder mac arm64..."
npm run dist:mac

# Pick the .dmg for THIS version, newest first.
#
# `ls dist/mac/*.dmg | head -1` was fine while the folder held one build. Once it
# held several it returned the ALPHABETICALLY first, which is the oldest version
# — and dist/ is gitignored, so nothing ever cleaned it. That is how the v0.4.0
# release went out carrying the 0.1.0 binary from two months earlier, at 192 MB
# against the 115 MB it should have been. Matching on the version out of
# package.json cannot drift, and the size is printed so a wrong one is obvious.
DMG=$(ls -t dist/mac/*"${VERSION}"*.dmg 2>/dev/null | head -1 || true)
if [ ! -f "${DMG:-}" ]; then
  echo "!! No .dmg for ${VERSION} in dist/mac — did electron-builder fail?" >&2
  exit 1
fi
MATCHES=$(ls dist/mac/*"${VERSION}"*.dmg 2>/dev/null | wc -l | tr -d ' ')
if [ "${MATCHES}" -gt 1 ]; then
  echo ">> Note: ${MATCHES} files match ${VERSION}; taking the newest." >&2
fi
echo ">> Built: ${DMG}  ($(du -h "${DMG}" | cut -f1))"

# 2. Upload to the existing release, or create it if it doesn't exist yet
if gh release view "${TAG}" -R "${REPO}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${DMG}" -R "${REPO}" --clobber
else
  gh release create "${TAG}" "${DMG}" \
    -R "${REPO}" \
    --title "Let'sMap! ${VERSION}" \
    --notes-file "RELEASE_NOTES_${TAG}.md"
fi

echo ">> Done."
