#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
TEMPLATE="${TEMPLATE:-$APP_DIR/deploy/nginx/phone-cloud.conf.example}"
OUTPUT="${OUTPUT:-}"
DOMAIN="${DOMAIN:-}"

env_value() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  sed -n "s/^$key=//p" "$ENV_FILE" | tail -n 1 | sed "s/^['\"]//;s/['\"]$//"
}

domain_from_url() {
  value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s\n' "$value"
}

if [ -z "$DOMAIN" ]; then
  public_base_url="$(env_value PUBLIC_BASE_URL)"
  if [ -n "$public_base_url" ]; then
    DOMAIN="$(domain_from_url "$public_base_url")"
  fi
fi

if [ -z "$DOMAIN" ]; then
  echo "DOMAIN is required, or set PUBLIC_BASE_URL in .env"
  exit 2
fi

case "$DOMAIN" in
  *[!A-Za-z0-9.-]*|.*|*..*|*.)
    echo "invalid DOMAIN: $DOMAIN"
    exit 2
    ;;
esac

if [ ! -f "$TEMPLATE" ]; then
  echo "nginx template not found: $TEMPLATE"
  exit 2
fi

if [ -n "$OUTPUT" ]; then
  mkdir -p "$(dirname "$OUTPUT")"
  sed "s/phone.example.com/$DOMAIN/g" "$TEMPLATE" > "$OUTPUT"
  echo "nginx config rendered: $OUTPUT"
else
  sed "s/phone.example.com/$DOMAIN/g" "$TEMPLATE"
fi
