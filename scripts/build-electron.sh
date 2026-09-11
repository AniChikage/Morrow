#!/usr/bin/env bash
set -euo pipefail

MORROW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# electron-builder.yml reads the packaged runtime from this path, so it stays inside the checkout.
MORROW_CACHE="$MORROW_ROOT/.build/runtime-cache"
# Optional shared download cache (Morrow's `local-script` releases pass MORROW_RUNTIME_CACHE) so a
# fresh worktree reuses one verified Node 24 instead of fetching it again. Unset keeps the default.
MORROW_NODE_CACHE="${MORROW_RUNTIME_CACHE:-$MORROW_CACHE}"
MORROW_APP="$MORROW_ROOT/dist/Morrow.app"
MORROW_ARCH="$(uname -m)"
if [ "$MORROW_ARCH" = arm64 ]; then MORROW_ELECTRON_ARCH=arm64; else MORROW_ELECTRON_ARCH=x64; fi

cd "$MORROW_ROOT"
mkdir -p "$MORROW_CACHE" "$MORROW_NODE_CACHE" "$MORROW_ROOT/dist"
# Fetch an official Node 24 binary on a fresh checkout and verify it before extraction.
if [ ! -x "$MORROW_CACHE/node/bin/node" ]; then
  if [ ! -x "$MORROW_NODE_CACHE/node/bin/node" ]; then
    curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$MORROW_NODE_CACHE/SHASUMS256.txt"
    MORROW_NODE_FILE="$(awk -v arch="$MORROW_ELECTRON_ARCH" '$2 ~ ("-darwin-" arch "\\.tar\\.gz$") {print $2}' "$MORROW_NODE_CACHE/SHASUMS256.txt")"
    if [[ ! "$MORROW_NODE_FILE" =~ ^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]]; then
      echo "Official Node 24 release for $MORROW_ELECTRON_ARCH not found." >&2
      exit 1
    fi
    curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/$MORROW_NODE_FILE" -o "$MORROW_NODE_CACHE/$MORROW_NODE_FILE"
    (cd "$MORROW_NODE_CACHE" && awk -v file="$MORROW_NODE_FILE" '$2 == file' SHASUMS256.txt | shasum -a 256 -c -)
    MORROW_NODE_TEMP="$(mktemp -d "$MORROW_NODE_CACHE/node-download.XXXXXX")"
    trap 'rm -rf "$MORROW_NODE_TEMP"' EXIT
    tar -xzf "$MORROW_NODE_CACHE/$MORROW_NODE_FILE" -C "$MORROW_NODE_TEMP" --strip-components=1
    "$MORROW_NODE_TEMP/bin/node" --version
    if [ -d "$MORROW_NODE_CACHE/node" ]; then rm -rf "$MORROW_NODE_CACHE/node"; fi
    mv "$MORROW_NODE_TEMP" "$MORROW_NODE_CACHE/node"
    trap - EXIT
  fi
  if [ "$MORROW_NODE_CACHE" != "$MORROW_CACHE" ]; then
    rm -rf "$MORROW_CACHE/node"
    ditto "$MORROW_NODE_CACHE/node" "$MORROW_CACHE/node"
    "$MORROW_CACHE/node/bin/node" --version
  fi
fi
swift "$MORROW_ROOT/scripts/make-icon.swift" "$MORROW_ROOT/assets/brand/morrow-icon.png" "$MORROW_CACHE/AppIcon.iconset"
iconutil -c icns "$MORROW_CACHE/AppIcon.iconset" -o "$MORROW_CACHE/Morrow.icns"
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --config electron-builder.yml --mac --dir --"$MORROW_ELECTRON_ARCH" --publish never
if [ "$MORROW_ELECTRON_ARCH" = arm64 ]; then
  MORROW_PACKAGED="$MORROW_ROOT/.build/electron-package/mac-arm64/Morrow.app"
else
  MORROW_PACKAGED="$MORROW_ROOT/.build/electron-package/mac/Morrow.app"
fi
if [ ! -d "$MORROW_PACKAGED" ]; then echo 'Electron package output was not found.' >&2; exit 1; fi

# Replace only the previous build artifact, never the installed app or daemon.
if [ -d "$MORROW_APP" ]; then rm -rf "$MORROW_APP"; fi
ditto "$MORROW_PACKAGED" "$MORROW_APP"
# The build identity: a read-only whole-bundle fingerprint over the service sources, the compiled
# Electron output and the package metadata. Written before signing so the signature covers it, and
# read once at start by the daemon and the Electron main to know which build they are running.
"$MORROW_CACHE/node/bin/node" "$MORROW_ROOT/scripts/build-info.ts" --root "$MORROW_ROOT" \
  --out "$MORROW_APP/Contents/Resources/build-info.json"
codesign --force --sign - "$MORROW_APP/Contents/Resources/bin/node"
codesign --force --deep --sign - "$MORROW_APP"
codesign --verify --deep --strict "$MORROW_APP"
echo "Built $MORROW_APP"
