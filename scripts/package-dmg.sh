#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Morrow.app"
OUTPUT="${1:-$ROOT/dist/Morrow.dmg}"
if [ ! -d "$APP" ]; then bash "$ROOT/scripts/build-app.sh"; fi
STAGE="$(mktemp -d "$ROOT/.build/morrow-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Morrow.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname Morrow -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT"
echo "Packaged $OUTPUT"
