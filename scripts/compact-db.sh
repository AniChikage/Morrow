#!/usr/bin/env bash
# Reclaims the disk space a pruned `workspace.sqlite` still occupies. Deleting rows returns their
# pages to SQLite's free list, not to the filesystem; only a VACUUM rewrites the file.
#
# Offline only: it refuses while a daemon holds the data directory, because a rewritten file under a
# live connection is how a database is lost. Stop Morrow (quit the app, and `bash
# scripts/login-service.sh uninstall` if the service runs at login) and run this.
#
#   bash scripts/compact-db.sh                       # the default data directory
#   bash scripts/compact-db.sh /path/to/data/dir     # another one, e.g. a copy
set -euo pipefail

DEFAULT_DATA="$HOME/Library/Application Support/Morrow"
LEGACY_DATA="$HOME/Library/Application Support/NoHuman"
if [ -n "${1:-}" ]; then DATA="$1"
elif [ -n "${MORROW_HOME:-}" ]; then DATA="$MORROW_HOME"
elif [ -n "${NOHUMAN_HOME:-}" ]; then DATA="$NOHUMAN_HOME"
elif [ -d "$DEFAULT_DATA" ] || [ ! -d "$LEGACY_DATA" ]; then DATA="$DEFAULT_DATA"
else DATA="$LEGACY_DATA"; fi

DB="$DATA/workspace.sqlite"
LOCK="$DATA/daemon.lock"
[ -f "$DB" ] || { echo "No database at $DB" >&2; exit 1; }

# The lock file names the pid that holds this data directory. A stale file (no such process) is
# reported and ignored; a live one stops us, since compacting under a running daemon is unsafe.
if [ -f "$LOCK" ]; then
  PID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$LOCK" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "A Morrow service (pid $PID) still holds $DATA. Stop it first; nothing was changed." >&2
    exit 1
  fi
  echo "Ignoring a stale $LOCK (no live process)."
fi

SIZE_BYTES="$(stat -f %z "$DB")"
# VACUUM INTO writes a second full copy next to the original, so the volume needs room for both.
FREE_BYTES="$(($(df -k "$DATA" | awk 'NR==2 {print $4}') * 1024))"
NEEDED=$((SIZE_BYTES + SIZE_BYTES / 10 + 67108864))
if [ "$FREE_BYTES" -lt "$NEEDED" ]; then
  echo "Need about $((NEEDED / 1048576)) MiB free on $DATA, have $((FREE_BYTES / 1048576)) MiB; nothing was changed." >&2
  exit 1
fi

TARGET="$DATA/workspace.sqlite.compact.$$"
rm -f "$TARGET"
cleanup() { [ -f "$TARGET" ] && rm -f "$TARGET"; }
trap cleanup EXIT

echo "Compacting $DB ($((SIZE_BYTES / 1048576)) MiB)…"
# Fold the write-ahead log back into the database first, so the copy below carries every commit.
sqlite3 "$DB" 'PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
sqlite3 "$DB" "VACUUM INTO '$TARGET'"
# The rewritten file has to be a readable database with the tables in it before it replaces anything.
sqlite3 "$TARGET" 'PRAGMA integrity_check;' | grep -qx ok
sqlite3 "$TARGET" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_threads';" | grep -qx 1

BACKUP="$DB.before-compact"
mv "$DB" "$BACKUP"
mv "$TARGET" "$DB"
chmod 600 "$DB"
# The old log and shared-memory files belong to the file that was just replaced.
rm -f "$DB-wal" "$DB-shm"
trap - EXIT
echo "Compacted: $((SIZE_BYTES / 1048576)) MiB -> $(($(stat -f %z "$DB") / 1048576)) MiB"
echo "Previous file kept at $BACKUP. Start Morrow, check it, then delete the copy."
