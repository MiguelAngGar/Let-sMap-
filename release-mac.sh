#!/usr/bin/env bash
# Let'sMap! — Mac build + GitHub release (arm64)
# Run on macOS. Requires: node/npm, gh CLI (brew install gh; gh auth login).
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
REPO="MiguelAngGar/Let-sMap-"

echo ">> Version: ${VERSION}  Tag: ${TAG}"

# 1. Ensure Python analyze binary exists (PyInstaller). Rebuild if missing.
if [ ! -e python/dist/analyze ]; then
  echo ">> Building python analyze binary..."
  ( cd python && pyinstaller analyze.spec --clean --noconfirm )
fi

# 2. Build mac arm64 dmg -> dist/mac/
echo ">> electron-builder mac arm64..."
npm run dist:mac

DMG=$(ls dist/mac/*.dmg | head -1)
echo ">> Built: ${DMG}"

# 3. Commit icon + config if changed
git add -f build/icon.png build/icon.icns build/icon.ico build/icon_master.svg 2>/dev/null || true
git add package.json .gitignore release-mac.sh 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "chore: app icon + point builder to png"
  git push origin main
fi

# 4. Tag
git tag -f "${TAG}"
git push -f origin "${TAG}"

# 5. GitHub release (create or reuse), upload dmg
if gh release view "${TAG}" -R "${REPO}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${DMG}" -R "${REPO}" --clobber
else
  gh release create "${TAG}" "${DMG}" \
    -R "${REPO}" \
    --title "Let'sMap! ${VERSION}" \
    --notes "macOS (Apple Silicon / arm64) build. Windows build to be added to this same release."
fi

echo ">> Done. Windows later: npm run dist:win && gh release upload ${TAG} dist/<win-installer>.exe -R ${REPO} --clobber"
