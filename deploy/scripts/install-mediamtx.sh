#!/usr/bin/env sh
set -eu

VERSION="${MEDIAMTX_VERSION:-1.18.2}"
ARCHIVE="mediamtx_v${VERSION}_linux_amd64.tar.gz"
BASE_DIR="${MEDIAMTX_BASE_DIR:-/opt/phone-cloud-mediamtx}"
CONFIG_DIR="${MEDIAMTX_CONFIG_DIR:-/etc/phone-cloud}"
SERVICE_FILE="/etc/systemd/system/phone-cloud-mediamtx.service"
SOURCE_DIR="${SOURCE_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

mkdir -p "$BASE_DIR" "$CONFIG_DIR"
curl -fL --retry 3 -o "/tmp/$ARCHIVE" "https://github.com/bluenviron/mediamtx/releases/download/v${VERSION}/${ARCHIVE}"
tar -xzf "/tmp/$ARCHIVE" -C "$BASE_DIR" mediamtx
chmod 0755 "$BASE_DIR/mediamtx"
install -m 0644 "$SOURCE_DIR/deploy/mediamtx.yml" "$CONFIG_DIR/mediamtx.yml"
install -m 0644 "$SOURCE_DIR/deploy/systemd/phone-cloud-mediamtx.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable --now phone-cloud-mediamtx
systemctl --no-pager --full status phone-cloud-mediamtx
