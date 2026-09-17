#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
STATE_FILE="${STATE_FILE:-$APP_DIR/data/state.json}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -z "$BACKUP_FILE" ]; then
  echo "usage: restore-json-state.sh /path/to/state-backup.json"
  exit 2
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "backup file not found: $BACKUP_FILE"
  exit 1
fi

mkdir -p "$(dirname "$STATE_FILE")"

if [ -f "$STATE_FILE" ]; then
  cp "$STATE_FILE" "$STATE_FILE.before-restore-$STAMP"
  echo "current state saved: $STATE_FILE.before-restore-$STAMP"
fi

cp "$BACKUP_FILE" "$STATE_FILE"
echo "state restored: $STATE_FILE"
