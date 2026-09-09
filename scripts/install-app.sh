#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$ROOT/dist/Morrow.app" ]; then bash "$ROOT/scripts/build-app.sh"; fi
DEST="${1:-$HOME/Applications}"
mkdir -p "$DEST"
if [ -d "$DEST/Morrow.app" ]; then
  mv "$DEST/Morrow.app" "$DEST/Morrow.previous.$(date +%Y%m%d%H%M%S).app"
fi
if [ -d "$DEST/NoHuman.app" ]; then
  mv "$DEST/NoHuman.app" "$DEST/NoHuman.previous.$(date +%Y%m%d%H%M%S).app"
fi
ditto "$ROOT/dist/Morrow.app" "$DEST/Morrow.app"
echo "Installed $DEST/Morrow.app"
