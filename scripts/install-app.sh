#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$ROOT/dist/NoHuman.app" ]; then bash "$ROOT/scripts/build-app.sh"; fi
DEST="${1:-$HOME/Applications}"
mkdir -p "$DEST"
if [ -d "$DEST/NoHuman.app" ]; then
  mv "$DEST/NoHuman.app" "$DEST/NoHuman.previous.$(date +%Y%m%d%H%M%S).app"
fi
ditto "$ROOT/dist/NoHuman.app" "$DEST/NoHuman.app"
echo "Installed $DEST/NoHuman.app"
