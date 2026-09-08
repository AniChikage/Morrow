#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/NoHuman.app"
OUTPUT="${1:-$ROOT/dist/NoHuman.dmg}"
if [ ! -d "$APP" ]; then bash "$ROOT/scripts/build-app.sh"; fi
STAGE="$(mktemp -d "$ROOT/.build/nohuman-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/NoHuman.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname NoHuman -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT"
echo "Packaged $OUTPUT"
