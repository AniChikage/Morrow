#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_APP="$HOME/Applications/Morrow.app"
LEGACY_APP="$HOME/Applications/NoHuman.app"
if [ -n "${MORROW_APP:-}" ]; then APP="$MORROW_APP"; elif [ -n "${NOHUMAN_APP:-}" ]; then APP="$NOHUMAN_APP"; elif [ -d "$DEFAULT_APP" ] || [ ! -d "$LEGACY_APP" ]; then APP="$DEFAULT_APP"; else APP="$LEGACY_APP"; fi
DEFAULT_DATA="$HOME/Library/Application Support/Morrow"
LEGACY_DATA="$HOME/Library/Application Support/NoHuman"
if [ -n "${MORROW_HOME:-}" ]; then DATA="$MORROW_HOME"; elif [ -n "${NOHUMAN_HOME:-}" ]; then DATA="$NOHUMAN_HOME"; elif [ -d "$DEFAULT_DATA" ] || [ ! -d "$LEGACY_DATA" ]; then DATA="$DEFAULT_DATA"; else DATA="$LEGACY_DATA"; fi
PLIST="$HOME/Library/LaunchAgents/ai.morrow.service.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/ai.nohuman.service.plist"
case "${1:-}" in
  install)
    if [ ! -x "$APP/Contents/Resources/bin/node" ]; then echo "Install the app first with scripts/install-app.sh" >&2; exit 1; fi
    mkdir -p "$HOME/Library/LaunchAgents" "$DATA"
    # plistlib handles spaces and XML metacharacters in paths without shell interpolation.
    python3 - "$APP" "$DATA" "$PLIST" <<'PY'
import sys, plistlib, os
app, data, path = sys.argv[1:]
with open(path, 'wb') as f:
    plistlib.dump({
        'Label':'ai.morrow.service',
        'ProgramArguments':[app+'/Contents/Resources/bin/node',app+'/Contents/Resources/service/server.ts'],
        'RunAtLoad':True,
        'KeepAlive':{'SuccessfulExit':False},
        'ThrottleInterval':15,
        'EnvironmentVariables':{'MORROW_HOME':data,'PATH':os.path.expanduser('~/.local/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
        'StandardOutPath':data+'/service.log',
        'StandardErrorPath':data+'/service.log'
    }, f)
PY
    if [ -f "$LEGACY_PLIST" ]; then
      launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
      mv "$LEGACY_PLIST" "$LEGACY_PLIST.disabled"
    fi
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Login service enabled. If Morrow is already running, the managed service will connect on the next login."
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    if [ -f "$PLIST" ]; then mv "$PLIST" "$PLIST.disabled"; fi
    launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
    if [ -f "$LEGACY_PLIST" ]; then mv "$LEGACY_PLIST" "$LEGACY_PLIST.disabled"; fi
    echo "Login service disabled. All project data retained."
    ;;
  *) echo "Usage: bash scripts/login-service.sh install|uninstall"; exit 1 ;;
esac
