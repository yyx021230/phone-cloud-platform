#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"

env_value() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  sed -n "s/^$key=//p" "$ENV_FILE" | tail -n 1 | sed "s/^['\"]//;s/['\"]$//"
}

DATABASE_URL="${DATABASE_URL:-$(env_value DATABASE_URL)}"
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is required"
  exit 2
fi

if [ -z "$BACKUP_FILE" ]; then
  echo "usage: restore-postgres-state.sh /path/to/postgres-state.dump"
  exit 2
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "backup file not found: $BACKUP_FILE"
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "pg_restore is required"
  exit 2
fi

pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$BACKUP_FILE"
echo "postgres state restored: $BACKUP_FILE"
