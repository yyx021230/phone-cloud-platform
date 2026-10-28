#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
RUN_PREFLIGHT="${RUN_PREFLIGHT:-true}"
START_STACK="${START_STACK:-true}"
INSTALL_BACKUP_TIMER="${INSTALL_BACKUP_TIMER:-false}"

echo "aliyun docker deploy: $APP_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required. Install Docker and the compose plugin first."
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required"
  exit 2
fi

cd "$APP_DIR"
mkdir -p data logs

if [ ! -f "$ENV_FILE" ]; then
  if [ -z "$PUBLIC_BASE_URL" ]; then
    echo "PUBLIC_BASE_URL is required when .env does not exist"
    echo "example: PUBLIC_BASE_URL=https://phone.example.cn $0"
    exit 2
  fi
  PUBLIC_BASE_URL="$PUBLIC_BASE_URL" APP_DIR="$APP_DIR" "$APP_DIR/deploy/scripts/generate-production-env.sh" "$ENV_FILE"
else
  echo ".env exists, skip generation: $ENV_FILE"
fi

if [ "$RUN_PREFLIGHT" = "true" ]; then
  APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" "$APP_DIR/deploy/scripts/preflight-production.sh"
fi

if [ "$START_STACK" = "true" ]; then
  # Always enforce media preservation, even when RUN_PREFLIGHT=false.
  node "$APP_DIR/deploy/mediamtx-pacing/verify.mjs" --deployment
  docker compose up -d --build
  docker compose ps
  node "$APP_DIR/deploy/mediamtx-pacing/verify.mjs" --deployment
fi

if [ "$INSTALL_BACKUP_TIMER" = "true" ]; then
  APP_DIR="$APP_DIR" "$APP_DIR/deploy/scripts/install-backup-timer.sh"
fi

echo "deploy finished"
echo "next: configure nginx, issue HTTPS certificate, then run deploy/scripts/smoke-test-platform.sh"
