#!/usr/bin/env sh
set -eu

SERVER_BASE_URL="${SERVER_BASE_URL:-http://127.0.0.1:8787}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-dev-admin-token}"
WINDOWS_AGENT_TOKEN="${WINDOWS_AGENT_TOKEN:-dev-windows-token}"
DEVICE_AGENT_TOKEN="${DEVICE_AGENT_TOKEN:-dev-device-token}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
AGENT_ID="${AGENT_ID:-timeout-windows-agent}"
DEVICE_ID="${DEVICE_ID:-timeout-device-1}"
QR_IMAGE_DATA_URL="${QR_IMAGE_DATA_URL:-data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=}"

json_get() {
  key="$1"
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);const path='$key'.split('.');let cur=obj;for(const item of path){cur=cur?.[item]}process.stdout.write(String(cur ?? ''))})"
}

request() {
  method="$1"
  path="$2"
  token="$3"
  body="${4:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$SERVER_BASE_URL$path" \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      --data "$body"
  else
    curl -fsS -X "$method" "$SERVER_BASE_URL$path" \
      -H "authorization: Bearer $token"
  fi
}

echo "admin login"
ADMIN_LOGIN_JSON="$(request POST /api/v1/auth/login "$ADMIN_API_TOKEN" "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")"
ADMIN_SESSION_TOKEN="$(printf '%s' "$ADMIN_LOGIN_JSON" | json_get session.token)"
printf '%s\n' "$ADMIN_LOGIN_JSON"

echo "windows heartbeat"
request POST /api/v1/windows-agents/heartbeat "$WINDOWS_AGENT_TOKEN" \
  "{\"agentId\":\"$AGENT_ID\",\"agentName\":\"Timeout Windows\",\"hostname\":\"timeout\",\"adbVersion\":\"Android Debug Bridge smoke\"}"
echo

echo "create windows task"
WINDOWS_TASK_JSON="$(request POST /api/v1/windows-agent-tasks "$ADMIN_SESSION_TOKEN" "{\"agentId\":\"$AGENT_ID\",\"type\":\"adb_collect_diagnostics\"}")"
printf '%s\n' "$WINDOWS_TASK_JSON"

echo "sync timeout device"
request POST "/api/v1/windows-agents/$AGENT_ID/devices/sync" "$WINDOWS_AGENT_TOKEN" \
  "{\"devices\":[{\"adbSerial\":\"TIMEOUT123\",\"deviceId\":\"$DEVICE_ID\",\"state\":\"device\",\"model\":\"TimeoutPhone\",\"androidVersion\":\"14\"}]}"
echo

echo "phone heartbeat"
request POST /api/v1/devices/heartbeat "$DEVICE_AGENT_TOKEN" \
  "{\"deviceId\":\"$DEVICE_ID\",\"deviceName\":\"Timeout Phone\",\"model\":\"TimeoutPhone\",\"androidVersion\":\"14\",\"appVersion\":\"timeout\"}"
echo

echo "create xhs task"
XHS_TASK_JSON="$(request POST /api/v1/xhs/qr-scan-tasks "$ADMIN_SESSION_TOKEN" "{\"deviceId\":\"$DEVICE_ID\",\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}")"
printf '%s\n' "$XHS_TASK_JSON"

echo "wait for short ttl"
sleep 2

echo "windows task expired"
WINDOWS_TASKS_JSON="$(request GET /api/v1/windows-agent-tasks "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$WINDOWS_TASKS_JSON"
WINDOWS_STATUS="$(printf '%s' "$WINDOWS_TASKS_JSON" | json_get tasks.0.status)"
if [ "$WINDOWS_STATUS" != "failed" ]; then
  echo "expected windows task failed after ttl, got $WINDOWS_STATUS"
  exit 1
fi

echo "xhs task expired"
XHS_TASKS_JSON="$(request GET /api/v1/xhs/qr-scan-tasks "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$XHS_TASKS_JSON"
XHS_STATUS="$(printf '%s' "$XHS_TASKS_JSON" | json_get tasks.0.status)"
if [ "$XHS_STATUS" != "expired" ]; then
  echo "expected xhs task expired after ttl, got $XHS_STATUS"
  exit 1
fi

echo "timeout smoke test completed"
