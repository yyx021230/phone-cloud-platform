#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
FAILURES=0

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL: %s\n' "$1"
}

pass() {
  printf ' OK : %s\n' "$1"
}

env_value() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  sed -n "s/^$key=//p" "$ENV_FILE" | tail -n 1 | sed "s/^['\"]//;s/['\"]$//"
}

require_value() {
  key="$1"
  value="$(env_value "$key")"
  if [ -n "$value" ]; then
    pass "$key is set"
  else
    fail "$key is required"
  fi
}

require_not_equal() {
  key="$1"
  forbidden="$2"
  value="$(env_value "$key")"
  if [ "$value" = "$forbidden" ]; then
    fail "$key still uses default value"
  else
    pass "$key changed from default"
  fi
}

require_min_len() {
  key="$1"
  min_len="$2"
  value="$(env_value "$key")"
  length="$(printf '%s' "$value" | wc -c | tr -d ' ')"
  if [ "$length" -ge "$min_len" ]; then
    pass "$key length >= $min_len"
  else
    fail "$key length must be >= $min_len"
  fi
}

require_positive_int() {
  key="$1"
  value="$(env_value "$key")"
  case "$value" in
    ''|*[!0-9]*) fail "$key must be a positive integer" ;;
    0) fail "$key must be greater than 0" ;;
    *) pass "$key is a positive integer" ;;
  esac
}

echo "production preflight: $APP_DIR"

if [ -f "$ENV_FILE" ]; then
  pass ".env exists"
else
  fail ".env not found at $ENV_FILE"
fi

require_value NODE_ENV
if [ "$(env_value NODE_ENV)" = "production" ]; then
  pass "NODE_ENV=production"
else
  fail "NODE_ENV must be production"
fi

if [ "$(env_value STRICT_PRODUCTION_CONFIG)" = "true" ]; then
  pass "STRICT_PRODUCTION_CONFIG=true"
else
  fail "STRICT_PRODUCTION_CONFIG must be true for production"
fi

STORAGE_BACKEND="$(env_value STORAGE_BACKEND)"
if [ -z "$STORAGE_BACKEND" ]; then
  STORAGE_BACKEND="json"
fi
case "$STORAGE_BACKEND" in
  json)
    pass "STORAGE_BACKEND=json"
    if [ "$(env_value ALLOW_JSON_STORAGE_IN_PRODUCTION)" = "true" ]; then
      pass "JSON storage production acknowledgement is explicit"
    else
      fail "ALLOW_JSON_STORAGE_IN_PRODUCTION must be true while this pilot build uses JSON storage"
    fi
    ;;
  postgres)
    pass "STORAGE_BACKEND=postgres"
    require_value DATABASE_URL
    require_value POSTGRES_PASSWORD
    require_min_len POSTGRES_PASSWORD 16
    require_not_equal POSTGRES_PASSWORD change-me-postgres-password
    case "$(env_value DATABASE_URL)" in
      *change-me-postgres-password*|*localhost*|*127.0.0.1*)
        fail "DATABASE_URL must not use placeholder/local credentials"
        ;;
      *)
        pass "DATABASE_URL is not a placeholder"
        ;;
    esac
    ;;
  *)
    fail "STORAGE_BACKEND must be json or postgres"
    ;;
esac

require_value PUBLIC_BASE_URL
PUBLIC_BASE_URL="$(env_value PUBLIC_BASE_URL)"
case "$PUBLIC_BASE_URL" in
  https://*) pass "PUBLIC_BASE_URL uses HTTPS" ;;
  *) fail "PUBLIC_BASE_URL must start with https://" ;;
esac
case "$PUBLIC_BASE_URL" in
  *localhost*|*127.0.0.1*|*phone.example.com*) fail "PUBLIC_BASE_URL still uses placeholder/local host" ;;
  *) pass "PUBLIC_BASE_URL is not a placeholder" ;;
esac

TRUSTED_ORIGINS="$(env_value TRUSTED_ORIGINS)"
case ",$TRUSTED_ORIGINS," in
  *",$PUBLIC_BASE_URL,"*) pass "TRUSTED_ORIGINS contains PUBLIC_BASE_URL" ;;
  *) fail "TRUSTED_ORIGINS must contain PUBLIC_BASE_URL" ;;
esac

for key in ADMIN_API_TOKEN WINDOWS_AGENT_TOKEN DEVICE_AGENT_TOKEN; do
  require_value "$key"
  require_min_len "$key" 32
done
require_not_equal ADMIN_API_TOKEN dev-admin-token
require_not_equal WINDOWS_AGENT_TOKEN dev-windows-token
require_not_equal DEVICE_AGENT_TOKEN dev-device-token

require_value EVIDENCE_SIGNING_SECRET
require_min_len EVIDENCE_SIGNING_SECRET 32
require_positive_int EVIDENCE_URL_TTL_SECONDS
require_value REDIS_URL
case "$(env_value REDIS_URL)" in
  redis://*|rediss://*) pass "REDIS_URL uses a Redis connection URL" ;;
  *) fail "REDIS_URL must start with redis:// or rediss://" ;;
esac
if [ "$(env_value LEGACY_WINDOWS_AGENT_TOKEN_ENABLED)" = "false" ]; then
  pass "legacy Windows Agent token compatibility is disabled"
else
  fail "LEGACY_WINDOWS_AGENT_TOKEN_ENABLED must be false for production"
fi

require_value ADMIN_USERNAME
require_value ADMIN_PASSWORD
require_min_len ADMIN_PASSWORD 12
MIN_PASSWORD_LENGTH="$(env_value MIN_PASSWORD_LENGTH)"
if [ -z "$MIN_PASSWORD_LENGTH" ]; then
  fail "MIN_PASSWORD_LENGTH is required"
elif [ "$MIN_PASSWORD_LENGTH" -lt 12 ] 2>/dev/null; then
  fail "MIN_PASSWORD_LENGTH must be >= 12"
else
  pass "MIN_PASSWORD_LENGTH is strong enough"
fi
if [ "$(env_value ADMIN_USERNAME)" = "admin" ] && [ "$(env_value ADMIN_PASSWORD)" = "admin123" ]; then
  fail "admin account still uses admin/admin123"
else
  pass "admin account changed from default"
fi

require_value DATA_DIR
DATA_DIR="$(env_value DATA_DIR)"
case "$DATA_DIR" in
  /*) DATA_PATH="$DATA_DIR" ;;
  *) DATA_PATH="$APP_DIR/$DATA_DIR" ;;
esac
mkdir -p "$DATA_PATH" "$DATA_PATH/backups" "$DATA_PATH/releases"
if [ -w "$DATA_PATH" ]; then
  pass "DATA_DIR is writable: $DATA_PATH"
else
  fail "DATA_DIR is not writable: $DATA_PATH"
fi

for key in MAX_QR_IMAGE_BYTES RETENTION_DAYS MAX_SMS_ORDERS MAX_SMS_EVENTS MAX_SMS_MESSAGES MAX_WINDOWS_TASKS MAX_XHS_TASKS MAX_EVIDENCE_ASSETS MAX_AUDIT_EVENTS MAX_SESSIONS; do
  require_value "$key"
  require_positive_int "$key"
done

if command -v node >/dev/null 2>&1; then
  pass "node is available"
  (cd "$APP_DIR" && npm run check)
else
  fail "node is required"
fi

SCREEN_IDLE_GUARD="$APP_DIR/public/screen-inactivity-guard.js"
if [ -f "$SCREEN_IDLE_GUARD" ] && grep -Eq '^export const SCREEN_IDLE_TIMEOUT_MS = 10 \* 60 \* 1000;$' "$SCREEN_IDLE_GUARD"; then
  pass "screen inactivity default is 10 minutes"
else
  fail "screen inactivity default must remain 10 minutes"
fi

if node "$APP_DIR/deploy/mediamtx-pacing/verify.mjs" --deployment; then
  pass "D-075 media baseline guard passed (see output for live vs repository-only scope)"
else
  fail "D-075 media pacing baseline must not regress"
fi

if [ -f "$APP_DIR/package-lock.json" ]; then
  pass "package-lock.json exists"
else
  fail "package-lock.json is required for reproducible npm installs"
fi

for script in "$APP_DIR"/deploy/scripts/*.sh; do
  sh -n "$script"
done
pass "shell scripts parse"

if [ -x "$APP_DIR/deploy/scripts/backup-current-storage.sh" ]; then
  pass "current storage backup script is executable"
else
  fail "deploy/scripts/backup-current-storage.sh must exist and be executable"
fi

for deploy_script in aliyun-docker-deploy.sh render-nginx-config.sh install-backup-timer.sh; do
  if [ -x "$APP_DIR/deploy/scripts/$deploy_script" ]; then
    pass "$deploy_script is executable"
  else
    fail "deploy/scripts/$deploy_script must exist and be executable"
  fi
done

if [ -f "$APP_DIR/docs/ALIYUN_DEPLOYMENT.md" ]; then
  pass "Aliyun deployment checklist exists"
else
  fail "docs/ALIYUN_DEPLOYMENT.md is required"
fi

BACKUP_SERVICE="$APP_DIR/deploy/systemd/phone-cloud-backup.service.example"
BACKUP_TIMER="$APP_DIR/deploy/systemd/phone-cloud-backup.timer.example"
if [ -f "$BACKUP_SERVICE" ] && [ -f "$BACKUP_TIMER" ]; then
  pass "systemd backup service and timer examples exist"
else
  fail "systemd backup service and timer examples are required"
fi

if [ -f "$BACKUP_SERVICE" ] && grep -q 'backup-current-storage.sh' "$BACKUP_SERVICE"; then
  pass "systemd backup service uses current storage backup script"
else
  fail "systemd backup service must run backup-current-storage.sh"
fi

if [ -f "$BACKUP_TIMER" ] && grep -q 'Persistent=true' "$BACKUP_TIMER" && grep -q '^OnCalendar=' "$BACKUP_TIMER"; then
  pass "systemd backup timer is persistent and scheduled"
else
  fail "systemd backup timer must set OnCalendar and Persistent=true"
fi

if grep -q 'npm ci --omit=dev' "$APP_DIR/Dockerfile"; then
  pass "Dockerfile uses npm ci"
else
  fail "Dockerfile must use npm ci --omit=dev"
fi

if [ -f "$APP_DIR/docker-compose.yml" ]; then
  pass "docker-compose.yml exists"
else
  fail "docker-compose.yml missing"
fi

if grep -q 'max-size: "20m"' "$APP_DIR/docker-compose.yml" && grep -q 'max-file: "5"' "$APP_DIR/docker-compose.yml"; then
  pass "docker-compose.yml limits container logs"
else
  fail "docker-compose.yml must set json-file max-size and max-file logging options"
fi

if grep -q '^HEALTHCHECK ' "$APP_DIR/Dockerfile"; then
  pass "Dockerfile has HEALTHCHECK"
else
  fail "Dockerfile must define HEALTHCHECK"
fi

if grep -q '/readyz' "$APP_DIR/Dockerfile"; then
  pass "Dockerfile HEALTHCHECK uses /readyz"
else
  fail "Dockerfile HEALTHCHECK must use /readyz"
fi

if [ -f "$APP_DIR/deploy/nginx/phone-cloud.conf.example" ]; then
  pass "nginx example exists"
else
  fail "nginx example missing"
fi

NGINX_EXAMPLE="$APP_DIR/deploy/nginx/phone-cloud.conf.example"
NGINX_HTTP_EXAMPLE="$APP_DIR/deploy/nginx/phone-cloud-http.conf.example"
if [ -f "$NGINX_HTTP_EXAMPLE" ]; then
  pass "nginx HTTP bootstrap example exists"
else
  fail "nginx HTTP bootstrap example missing"
fi

if grep -q 'client_max_body_size 256m' "$NGINX_EXAMPLE"; then
  pass "nginx example allows large APK upload"
else
  fail "nginx example must set client_max_body_size 256m or higher"
fi

if grep -q 'proxy_request_buffering off' "$NGINX_EXAMPLE"; then
  pass "nginx example disables proxy request buffering"
else
  fail "nginx example must disable proxy request buffering for APK uploads"
fi

if grep -q 'Strict-Transport-Security' "$NGINX_EXAMPLE"; then
  pass "nginx example sets HSTS"
else
  fail "nginx example should set Strict-Transport-Security"
fi

if grep -q 'X-Forwarded-Proto https' "$NGINX_EXAMPLE"; then
  pass "nginx example forwards HTTPS scheme"
else
  fail "nginx example must forward X-Forwarded-Proto https"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "production preflight failed: $FAILURES issue(s)"
  exit 1
fi

echo "production preflight passed"
