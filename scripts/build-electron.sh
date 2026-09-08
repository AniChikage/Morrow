#!/usr/bin/env bash
set -euo pipefail

NOHUMAN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOHUMAN_CACHE="$NOHUMAN_ROOT/.build/runtime-cache"
NOHUMAN_APP="$NOHUMAN_ROOT/dist/NoHuman.app"
NOHUMAN_ARCH="$(uname -m)"
if [ "$NOHUMAN_ARCH" = arm64 ]; then NOHUMAN_ELECTRON_ARCH=arm64; else NOHUMAN_ELECTRON_ARCH=x64; fi

cd "$NOHUMAN_ROOT"
mkdir -p "$NOHUMAN_CACHE" "$NOHUMAN_ROOT/dist"
# Fetch an official Node 24 binary on a fresh checkout and verify it before extraction.
if [ ! -x "$NOHUMAN_CACHE/node/bin/node" ]; then
  curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$NOHUMAN_CACHE/SHASUMS256.txt"
  NOHUMAN_NODE_FILE="$(awk -v arch="$NOHUMAN_ELECTRON_ARCH" '$2 ~ ("-darwin-" arch "\\.tar\\.gz$") {print $2}' "$NOHUMAN_CACHE/SHASUMS256.txt")"
  if [[ ! "$NOHUMAN_NODE_FILE" =~ ^node-v24\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]]; then
    echo "Official Node 24 release for $NOHUMAN_ELECTRON_ARCH not found." >&2
    exit 1
  fi
  curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/$NOHUMAN_NODE_FILE" -o "$NOHUMAN_CACHE/$NOHUMAN_NODE_FILE"
  (cd "$NOHUMAN_CACHE" && awk -v file="$NOHUMAN_NODE_FILE" '$2 == file' SHASUMS256.txt | shasum -a 256 -c -)
  NOHUMAN_NODE_TEMP="$(mktemp -d "$NOHUMAN_CACHE/node-download.XXXXXX")"
  trap 'rm -rf "$NOHUMAN_NODE_TEMP"' EXIT
  tar -xzf "$NOHUMAN_CACHE/$NOHUMAN_NODE_FILE" -C "$NOHUMAN_NODE_TEMP" --strip-components=1
  "$NOHUMAN_NODE_TEMP/bin/node" --version
  if [ -d "$NOHUMAN_CACHE/node" ]; then rm -rf "$NOHUMAN_CACHE/node"; fi
  mv "$NOHUMAN_NODE_TEMP" "$NOHUMAN_CACHE/node"
  trap - EXIT
fi
swift "$NOHUMAN_ROOT/scripts/make-icon.swift" "$NOHUMAN_CACHE/AppIcon.iconset"
iconutil -c icns "$NOHUMAN_CACHE/AppIcon.iconset" -o "$NOHUMAN_CACHE/NoHuman.icns"
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --config electron-builder.yml --mac --dir --"$NOHUMAN_ELECTRON_ARCH" --publish never
if [ "$NOHUMAN_ELECTRON_ARCH" = arm64 ]; then
  NOHUMAN_PACKAGED="$NOHUMAN_ROOT/.build/electron-package/mac-arm64/NoHuman.app"
else
  NOHUMAN_PACKAGED="$NOHUMAN_ROOT/.build/electron-package/mac/NoHuman.app"
fi
if [ ! -d "$NOHUMAN_PACKAGED" ]; then echo 'Electron package output was not found.' >&2; exit 1; fi

# Replace only the previous build artifact, never the installed app or daemon.
if [ -d "$NOHUMAN_APP" ]; then rm -rf "$NOHUMAN_APP"; fi
ditto "$NOHUMAN_PACKAGED" "$NOHUMAN_APP"
codesign --force --sign - "$NOHUMAN_APP/Contents/Resources/bin/node"
codesign --force --deep --sign - "$NOHUMAN_APP"
codesign --verify --deep --strict "$NOHUMAN_APP"
echo "Built $NOHUMAN_APP"
