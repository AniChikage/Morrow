#!/usr/bin/env bash
set -euo pipefail

# Canonical desktop build. The legacy UI is available through build-swiftui.sh.
NOHUMAN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$NOHUMAN_ROOT/scripts/build-electron.sh" "$@"
