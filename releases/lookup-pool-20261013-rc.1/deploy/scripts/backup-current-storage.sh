#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

env_value() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  sed -n "s/^$key=//p" "$ENV_FILE" | tail -n 1 | sed "s/^['\"]//;s/['\"]$//"
}

storage_backend() {
  value="${STORAGE_BACKEND:-$(env_value STORAGE_BACKEND)}"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf 'json\n'
  fi
}

backup_postgres_from_compose() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  if ! (cd "$APP_DIR" && docker compose ps -q postgres >/dev/null 2>&1); then
    return 1
  fi

  mkdir -p "$BACKUP_DIR"
  stamp="$(date +%Y%m%d-%H%M%S)"
  target="$BACKUP_DIR/postgres-state-$stamp.dump"
  tmp="$target.tmp"
  postgres_user="${POSTGRES_USER:-phone_cloud}"
  postgres_db="${POSTGRES_DB:-phone_cloud}"

  if (cd "$APP_DIR" && docker compose exec -T postgres pg_dump --format=custom --table phone_cloud_state -U "$postgres_user" "$postgres_db" > "$tmp"); then
    mv "$tmp" "$target"
    find "$BACKUP_DIR" -name 'postgres-state-*.dump' -type f -mtime +"$RETENTION_DAYS" -delete
    echo "postgres compose backup saved: $target"
    return 0
  fi

  rm -f "$tmp"
  return 1
}

case "$(storage_backend)" in
  json)
    APP_DIR="$APP_DIR" BACKUP_DIR="$BACKUP_DIR" "$APP_DIR/deploy/scripts/backup-json-state.sh"
    ;;
  postgres)
    if backup_postgres_from_compose; then
      exit 0
    fi
    APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" BACKUP_DIR="$BACKUP_DIR" "$APP_DIR/deploy/scripts/backup-postgres-state.sh"
    ;;
  *)
    echo "STORAGE_BACKEND must be json or postgres"
    exit 2
    ;;
esac
