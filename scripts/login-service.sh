#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${NOHUMAN_APP:-$HOME/Applications/NoHuman.app}"
DATA="${NOHUMAN_HOME:-$HOME/Library/Application Support/NoHuman}"
PLIST="$HOME/Library/LaunchAgents/ai.nohuman.service.plist"
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
        'Label':'ai.nohuman.service',
        'ProgramArguments':[app+'/Contents/Resources/bin/node',app+'/Contents/Resources/service/server.ts'],
        'RunAtLoad':True,
        'KeepAlive':{'SuccessfulExit':False},
        'ThrottleInterval':15,
        'EnvironmentVariables':{'NOHUMAN_HOME':data,'PATH':os.path.expanduser('~/.local/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
        'StandardOutPath':data+'/service.log',
        'StandardErrorPath':data+'/service.log'
    }, f)
PY
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Login service enabled. If NoHuman is already running, the managed service will connect on the next login."
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    if [ -f "$PLIST" ]; then mv "$PLIST" "$PLIST.disabled"; fi
    echo "Login service disabled. All project data retained."
    ;;
  *) echo "Usage: bash scripts/login-service.sh install|uninstall"; exit 1 ;;
esac
