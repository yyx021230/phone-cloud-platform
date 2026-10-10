#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

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

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump is required"
  exit 2
fi

mkdir -p "$BACKUP_DIR"
TARGET="$BACKUP_DIR/postgres-state-$STAMP.dump"
pg_dump --format=custom --file "$TARGET" --table phone_cloud_state "$DATABASE_URL"
find "$BACKUP_DIR" -name 'postgres-state-*.dump' -type f -mtime +30 -delete
echo "postgres backup saved: $TARGET"
