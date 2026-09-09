#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Legacy SwiftUI build; keep it separate from the canonical Electron application.
APP="$ROOT/dist/Morrow-SwiftUI.app"
CACHE="$ROOT/.build/runtime-cache"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then NODE_ARCH=arm64; else NODE_ARCH=x64; fi

mkdir -p "$CACHE" "$APP/Contents/MacOS" "$APP/Contents/Resources/service" "$APP/Contents/Resources/bin"

# Bundle the official self-contained Node binary so Finder launches do not depend on Homebrew.
if [ ! -x "$CACHE/node/bin/node" ]; then
  curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt"
  NODE_FILE="$(awk -v arch="$NODE_ARCH" '$2 ~ ("-darwin-" arch "\\.tar\\.gz$") {print $2}' "$CACHE/SHASUMS256.txt")"
  if [ -z "$NODE_FILE" ]; then echo "Official Node release for $NODE_ARCH not found" >&2; exit 1; fi
  curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/$NODE_FILE" -o "$CACHE/$NODE_FILE"
  (cd "$CACHE" && awk -v file="$NODE_FILE" '$2 == file' SHASUMS256.txt | shasum -a 256 -c -)
  mkdir -p "$CACHE/node"
  tar -xzf "$CACHE/$NODE_FILE" -C "$CACHE/node" --strip-components=1
fi

cd "$ROOT"
swift build -c release
cp "$ROOT/.build/release/Morrow" "$APP/Contents/MacOS/Morrow"
cp -R "$ROOT/service/." "$APP/Contents/Resources/service/"
cp "$CACHE/node/bin/node" "$APP/Contents/Resources/bin/node"
cp "$CACHE/node/LICENSE" "$APP/Contents/Resources/Node-LICENSE.txt"
swift "$ROOT/scripts/make-icon.swift" "$ROOT/assets/brand/morrow-icon.png" "$CACHE/AppIcon.iconset"
iconutil -c icns "$CACHE/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Morrow</string>
  <key>CFBundleDisplayName</key><string>Morrow</string>
  <key>CFBundleIdentifier</key><string>ai.morrow.desktop</string>
  <key>CFBundleExecutable</key><string>Morrow</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

codesign --force --sign - "$APP/Contents/Resources/bin/node"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
