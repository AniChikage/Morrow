#!/usr/bin/env bash
# Isolated fixture for the `local-script` release target. It builds its receipt from the environment
# Morrow passes, records that environment for inspection, and writes nothing outside its own release
# directory. It never builds or installs anything; the real script is scripts/release-local.sh.
set -euo pipefail
MODE="${1:-publish}"
RELEASE_DIR="$(dirname "$MORROW_RECEIPT_PATH")"
# Everything this script can see. Bash itself adds PWD/SHLVL/OLDPWD/_ on top of what Morrow passed.
printenv | sort >"$RELEASE_DIR/env.txt"
echo "fixture mode $MODE in $PWD" >&2
RECEIPT="{\"releaseId\":\"$MORROW_RELEASE_ID\",\"artifactSha256\":\"$MORROW_ARTIFACT_SHA256\""
RECEIPT="$RECEIPT,\"status\":\"published\",\"reviewHash\":\"$MORROW_REVIEW_HASH\""
RECEIPT="$RECEIPT,\"cache\":\"$MORROW_RUNTIME_CACHE\",\"mode\":\"$MODE\"}"
case "$MODE" in
publish | status)
  printf '%s\n' "$RECEIPT" >"$MORROW_RECEIPT_PATH"
  echo 'preparing the isolated fixture release'
  printf '%s\n' "$RECEIPT"
  ;;
quiet)
  # Writes the receipt file but prints no receipt: the publication stays unconfirmed until reconciled.
  printf '%s\n' "$RECEIPT" >"$MORROW_RECEIPT_PATH"
  echo 'wrote the receipt file only' >&2
  ;;
fail)
  echo 'fixture gate failed' >&2
  exit 1
  ;;
garbage)
  echo 'this line is not a receipt'
  ;;
sleep)
  sleep 30
  ;;
*)
  echo "unknown fixture mode $MODE" >&2
  exit 2
  ;;
esac
