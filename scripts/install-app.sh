#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$ROOT/dist/Morrow.app" ]; then bash "$ROOT/scripts/build-app.sh"; fi
DEST="${1:-$HOME/Applications}"
mkdir -p "$DEST"
STAGE="$(mktemp -d "$DEST/.morrow-install.XXXXXX")"
cleanup() {
  local result=$?
  if [ -d "$STAGE/previous.app" ] && [ ! -e "$DEST/Morrow.app" ]; then
    mv "$STAGE/previous.app" "$DEST/Morrow.app"
  fi
  rm -rf "$STAGE"
  exit "$result"
}
trap cleanup EXIT
# Verify the complete copy before replacing the installed bundle. Keep a rollback
# only during replacement, not a growing collection of full application backups.
ditto "$ROOT/dist/Morrow.app" "$STAGE/Morrow.app"
codesign --verify --deep --strict "$STAGE/Morrow.app"
if [ -e "$DEST/Morrow.app" ]; then
  mv "$DEST/Morrow.app" "$STAGE/previous.app"
fi
mv "$STAGE/Morrow.app" "$DEST/Morrow.app"
echo "Installed $DEST/Morrow.app"
# Existing native launchers and a running daemon may still use absolute paths
# inside the legacy bundle. Keep it until their owner switches to Morrow.
if [ -d "$DEST/NoHuman.app" ] && [ ! -L "$DEST/NoHuman.app" ]; then
  echo "Kept the legacy app for existing Codex launchers and service processes. See README.md for upgrade steps."
fi
