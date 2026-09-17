#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-$(pwd)}"
SERVER_PORT="${SERVER_PORT:-8791}"
SERVER_BASE_URL="${SERVER_BASE_URL:-http://127.0.0.1:$SERVER_PORT}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgresSmokePass123456}"
POSTGRES_PORT="${POSTGRES_PORT:-55432}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-phone-cloud-postgres-smoke}"
DATABASE_URL="${DATABASE_URL:-postgres://phone_cloud:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/phone_cloud}"
ADMIN_USERNAME="${ADMIN_USERNAME:-pg_admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-pgAdminPass12345}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-pg_admin_token_12345678901234567890}"
WINDOWS_AGENT_TOKEN="${WINDOWS_AGENT_TOKEN:-pg_windows_token_123456789012345678}"
DEVICE_AGENT_TOKEN="${DEVICE_AGENT_TOKEN:-pg_device_token_12345678901234567890}"
SMOKE_USERNAME="${SMOKE_USERNAME:-pg_user_$(date +%s)}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-pgUserPass12345}"
SMOKE_NEW_PASSWORD="${SMOKE_NEW_PASSWORD:-pgUserNewPass12345}"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

json_get() {
  key="$1"
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);const path='$key'.split('.');let cur=obj;for(const item of path){cur=cur?.[item]}process.stdout.write(String(cur ?? ''))})"
}

wait_for_http() {
  url="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if curl -fsS "$url" >/tmp/phone-cloud-postgres-ready.json 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "timeout waiting for $url"
  cat /tmp/phone-cloud-postgres-ready.json 2>/dev/null || true
  return 1
}

wait_for_postgres() {
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U phone_cloud -d phone_cloud >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timeout waiting for postgres"
  docker logs "$POSTGRES_CONTAINER" 2>/dev/null || true
  return 1
}

start_server() {
  NODE_ENV=production \
  STRICT_PRODUCTION_CONFIG=true \
  STORAGE_BACKEND=postgres \
  DATABASE_URL="$DATABASE_URL" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  PUBLIC_BASE_URL="https://phone.example.cn" \
  ADMIN_USERNAME="$ADMIN_USERNAME" \
  ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  ADMIN_API_TOKEN="$ADMIN_API_TOKEN" \
  WINDOWS_AGENT_TOKEN="$WINDOWS_AGENT_TOKEN" \
  DEVICE_AGENT_TOKEN="$DEVICE_AGENT_TOKEN" \
  HOST=127.0.0.1 \
  PORT="$SERVER_PORT" \
  DATA_DIR="$APP_DIR/data" \
  npm start >/tmp/phone-cloud-postgres-server.log 2>&1 &
  SERVER_PID="$!"
  wait_for_http "$SERVER_BASE_URL/readyz"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required"
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 2
fi

echo "starting postgres"
docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$POSTGRES_CONTAINER" \
  -e POSTGRES_DB=phone_cloud \
  -e POSTGRES_USER=phone_cloud \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -p "127.0.0.1:$POSTGRES_PORT:5432" \
  postgres:16-alpine >/dev/null
wait_for_postgres

echo "starting server with postgres storage"
cd "$APP_DIR"
start_server

echo "running platform smoke against postgres"
SERVER_BASE_URL="$SERVER_BASE_URL" \
ADMIN_API_TOKEN="$ADMIN_API_TOKEN" \
WINDOWS_AGENT_TOKEN="$WINDOWS_AGENT_TOKEN" \
DEVICE_AGENT_TOKEN="$DEVICE_AGENT_TOKEN" \
ADMIN_USERNAME="$ADMIN_USERNAME" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
SMOKE_USERNAME="$SMOKE_USERNAME" \
SMOKE_PASSWORD="$SMOKE_PASSWORD" \
SMOKE_NEW_PASSWORD="$SMOKE_NEW_PASSWORD" \
"$APP_DIR/deploy/scripts/smoke-test-platform.sh"

echo "checking postgres snapshot"
SNAPSHOT_JSON="$(docker exec "$POSTGRES_CONTAINER" psql -U phone_cloud -d phone_cloud -Atc "select jsonb_array_length(data->'users') from phone_cloud_state where state_key = 'default'")"
if [ "${SNAPSHOT_JSON:-0}" -lt 2 ]; then
  echo "expected postgres snapshot to contain at least admin and smoke user, got $SNAPSHOT_JSON"
  exit 1
fi

echo "restarting server to verify postgres persistence"
kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
start_server

LOGIN_JSON="$(curl -fsS -X POST "$SERVER_BASE_URL/api/v1/auth/login" \
  -H "content-type: application/json" \
  --data "{\"username\":\"$SMOKE_USERNAME\",\"password\":\"$SMOKE_NEW_PASSWORD\"}")"
if [ -z "$(printf '%s' "$LOGIN_JSON" | json_get session.token)" ]; then
  echo "expected smoke user login after restart"
  exit 1
fi

echo "postgres smoke test completed"
