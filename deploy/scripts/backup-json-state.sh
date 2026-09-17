#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backups}"
STATE_FILE="${STATE_FILE:-$APP_DIR/data/state.json}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [ -f "$STATE_FILE" ]; then
  cp "$STATE_FILE" "$BACKUP_DIR/state-$STAMP.json"
  find "$BACKUP_DIR" -name 'state-*.json' -type f -mtime +30 -delete
  echo "backup saved: $BACKUP_DIR/state-$STAMP.json"
else
  echo "state file not found: $STATE_FILE"
fi
