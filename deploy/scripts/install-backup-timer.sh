#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/opt/phone-cloud-platform}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE_NAME="${SERVICE_NAME:-phone-cloud-backup}"
BACKUP_USER="${BACKUP_USER:-$(id -un)}"
BACKUP_GROUP="${BACKUP_GROUP:-$(id -gn)}"
SUDO="${SUDO:-}"

if [ "$(id -u)" != "0" ] && [ -z "$SUDO" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required"
  exit 2
fi

if [ ! -f "$APP_DIR/deploy/systemd/phone-cloud-backup.service.example" ]; then
  echo "service example not found under APP_DIR: $APP_DIR"
  exit 2
fi

if [ ! -f "$APP_DIR/deploy/systemd/phone-cloud-backup.timer.example" ]; then
  echo "timer example not found under APP_DIR: $APP_DIR"
  exit 2
fi

service_tmp="$(mktemp)"
timer_tmp="$(mktemp)"
trap 'rm -f "$service_tmp" "$timer_tmp"' EXIT

sed \
  -e "s#/opt/phone-cloud-platform#$APP_DIR#g" \
  -e "s/^User=phonecloud$/User=$BACKUP_USER/" \
  -e "s/^Group=phonecloud$/Group=$BACKUP_GROUP/" \
  "$APP_DIR/deploy/systemd/phone-cloud-backup.service.example" > "$service_tmp"
sed "s#phone-cloud-backup.service#$SERVICE_NAME.service#g" \
  "$APP_DIR/deploy/systemd/phone-cloud-backup.timer.example" > "$timer_tmp"

$SUDO mkdir -p "$SYSTEMD_DIR"
$SUDO cp "$service_tmp" "$SYSTEMD_DIR/$SERVICE_NAME.service"
$SUDO cp "$timer_tmp" "$SYSTEMD_DIR/$SERVICE_NAME.timer"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE_NAME.timer"
$SUDO systemctl list-timers "$SERVICE_NAME.timer" --no-pager

echo "backup timer installed: $SERVICE_NAME.timer"
echo "backup timer user: $BACKUP_USER:$BACKUP_GROUP"
