#!/bin/bash
# VidDock Release Packaging Script
# Builds, tests, packages Chrome extension, macOS installer bundle, source zip, and SHA256 checksums.

set -euo pipefail

SCRIPT_DIR="$( cd -P "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd )"

cd "$REPO_ROOT"

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
RELEASE_DIR="$REPO_ROOT/release"

echo "Building VidDock Release: $TAG"
echo "----------------------------------------"

# 1. Clean & Rebuild
echo "-> Running quality gate checks (typecheck, lint, test, build)..."
npm run typecheck
npm run lint
npm test
npm run build

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# 2. Package Chrome Extension Bundle (unpacked ready)
CHROME_ZIP="$RELEASE_DIR/VidDock-${TAG}-chrome.zip"
echo "-> Packaging Chrome Extension to $CHROME_ZIP..."
(
  cd "$REPO_ROOT/apps/extension/dist"
  zip -r -q "$CHROME_ZIP" .
)

# 3. Package macOS Companion Installer Bundle
MACOS_ZIP="$RELEASE_DIR/VidDock-${TAG}-macos-installer.zip"
MACOS_STAGING="$RELEASE_DIR/staging-macos"
echo "-> Packaging macOS Companion Installer to $MACOS_ZIP..."
rm -rf "$MACOS_STAGING"
mkdir -p "$MACOS_STAGING/dist/host"
mkdir -p "$MACOS_STAGING/scripts"

cp -R "$REPO_ROOT/dist/host/"* "$MACOS_STAGING/dist/host/"
cp "$REPO_ROOT/scripts/install-macos.sh" "$MACOS_STAGING/scripts/"
cp "$REPO_ROOT/scripts/uninstall-macos.sh" "$MACOS_STAGING/scripts/"
cp "$REPO_ROOT/scripts/verify-installation.sh" "$MACOS_STAGING/scripts/"
cp "$REPO_ROOT/LICENSE" "$MACOS_STAGING/"

cat > "$MACOS_STAGING/README.txt" <<EOF
VidDock Native Companion Host for macOS ($TAG)
================================================

This package contains the local Native Messaging companion host for VidDock.
The native companion enables lossless FFmpeg stream remuxing, HLS/DASH downloads,
and Mediasite multi-track lecture assembly.

Installation:
1. Open Terminal in this folder.
2. Run:
     ./scripts/install-macos.sh
   (Optional: specify your Chrome extension ID if installed unpacked:
     ./scripts/install-macos.sh <EXTENSION_ID>)

Verification:
3. Run:
     ./scripts/verify-installation.sh

Uninstallation:
4. Run:
     ./scripts/uninstall-macos.sh
EOF

chmod +x "$MACOS_STAGING/scripts/"*.sh
chmod +x "$MACOS_STAGING/dist/host/"*.sh 2>/dev/null || true

(
  cd "$MACOS_STAGING"
  zip -r -q "$MACOS_ZIP" .
)
rm -rf "$MACOS_STAGING"

# 4. Package Source Archive
SOURCE_ZIP="$RELEASE_DIR/VidDock-${TAG}-source.zip"
echo "-> Packaging Clean Source Archive to $SOURCE_ZIP..."
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git archive --format=zip --prefix="VidDock-${TAG}/" -o "$SOURCE_ZIP" HEAD
else
  zip -r -q -x "node_modules/*" ".git/*" "release/*" "dist/*" -o "$SOURCE_ZIP" .
fi

# 5. Generate SHA256 Checksums
echo "-> Generating SHA256SUMS.txt..."
(
  cd "$RELEASE_DIR"
  shasum -a 256 "VidDock-${TAG}-chrome.zip" "VidDock-${TAG}-macos-installer.zip" "VidDock-${TAG}-source.zip" > SHA256SUMS.txt
)

echo "----------------------------------------"
echo "Release artifacts generated in $RELEASE_DIR:"
ls -lh "$RELEASE_DIR"
echo ""
echo "Checksums:"
cat "$RELEASE_DIR/SHA256SUMS.txt"
echo "----------------------------------------"
echo "VidDock $TAG release packaging complete."
