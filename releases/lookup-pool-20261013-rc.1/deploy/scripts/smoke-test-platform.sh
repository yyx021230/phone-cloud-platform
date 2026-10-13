#!/usr/bin/env sh
set -eu

SERVER_BASE_URL="${SERVER_BASE_URL:-http://127.0.0.1:8787}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-dev-admin-token}"
WINDOWS_AGENT_TOKEN="${WINDOWS_AGENT_TOKEN:-dev-windows-token}"
DEVICE_AGENT_TOKEN="${DEVICE_AGENT_TOKEN:-dev-device-token}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
AGENT_ID="${AGENT_ID:-smoke-windows-agent}"
DEVICE_ID="${DEVICE_ID:-smoke-device-1}"
SMOKE_PHONE="${SMOKE_PHONE:-+8613800000000}"
STAMP="$(date +%s)"
SMOKE_USERNAME="${SMOKE_USERNAME:-smoke_user_$STAMP}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-smokePass$STAMP}"
SMOKE_NEW_PASSWORD="${SMOKE_NEW_PASSWORD:-smokeNewPass$STAMP}"
QR_IMAGE_DATA_URL="${QR_IMAGE_DATA_URL:-data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=}"

json_get() {
  key="$1"
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);const path='$key'.split('.');let cur=obj;for(const item of path){cur=cur?.[item]}process.stdout.write(String(cur ?? ''))})"
}

json_agent_health_warning() {
  agent_id="$1"
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);const agent=(obj.agents||[]).find((item)=>item.agentId==='$agent_id');process.stdout.write(String(agent?.health?.warnings?.[0] ?? ''))})"
}

json_latest_sms_order_status() {
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);process.stdout.write(String(obj.orders?.[0]?.status ?? ''))})"
}

json_phone_present() {
  phone="$1"
  node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const obj=JSON.parse(data);process.stdout.write(String((obj.phones||[]).some((item)=>item.phoneNumber==='$phone')));})"
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

echo "healthz"
curl -fsS "$SERVER_BASE_URL/healthz"
echo

echo "readyz"
READY_JSON="$(curl -fsS "$SERVER_BASE_URL/readyz")"
printf '%s\n' "$READY_JSON"
if [ "$(printf '%s' "$READY_JSON" | json_get ok)" != "true" ]; then
  echo "expected readyz ok=true"
  exit 1
fi
echo

echo "login rate limit"
RATE_LIMIT_STATUS=""
for _ in 1 2 3 4 5 6 7 8 9; do
  RATE_LIMIT_STATUS="$(curl -s -o /tmp/phone-cloud-rate-limit.json -w '%{http_code}' -X POST "$SERVER_BASE_URL/api/v1/auth/login" \
    -H "content-type: application/json" \
    --data "{\"username\":\"missing_$STAMP\",\"password\":\"bad\"}")"
done
if [ "$RATE_LIMIT_STATUS" != "429" ]; then
  echo "expected 429 from login rate limit, got $RATE_LIMIT_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-rate-limit.json
echo

echo "admin login"
ADMIN_LOGIN_JSON="$(request POST /api/v1/auth/login "$ADMIN_API_TOKEN" "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")"
ADMIN_SESSION_TOKEN="$(printf '%s' "$ADMIN_LOGIN_JSON" | json_get session.token)"
printf '%s\n' "$ADMIN_LOGIN_JSON"

echo "admin diagnostics"
request GET /api/v1/diagnostics "$ADMIN_SESSION_TOKEN"
echo

echo "create smoke user"
CREATE_USER_JSON="$(request POST /api/v1/users "$ADMIN_SESSION_TOKEN" "{\"username\":\"$SMOKE_USERNAME\",\"password\":\"$SMOKE_PASSWORD\",\"displayName\":\"Smoke User\",\"role\":\"user\"}")"
SMOKE_USER_ID="$(printf '%s' "$CREATE_USER_JSON" | json_get user.userId)"
printf '%s\n' "$CREATE_USER_JSON"
echo

echo "user login"
USER_LOGIN_JSON="$(request POST /api/v1/auth/login "$ADMIN_API_TOKEN" "{\"username\":\"$SMOKE_USERNAME\",\"password\":\"$SMOKE_PASSWORD\"}")"
USER_SESSION_TOKEN="$(printf '%s' "$USER_LOGIN_JSON" | json_get session.token)"
printf '%s\n' "$USER_LOGIN_JSON"

echo "user password change"
request POST /api/v1/auth/password "$USER_SESSION_TOKEN" \
  "{\"currentPassword\":\"$SMOKE_PASSWORD\",\"newPassword\":\"$SMOKE_NEW_PASSWORD\"}"
echo

echo "user login with new password"
USER_LOGIN_JSON="$(request POST /api/v1/auth/login "$ADMIN_API_TOKEN" "{\"username\":\"$SMOKE_USERNAME\",\"password\":\"$SMOKE_NEW_PASSWORD\"}")"
USER_SESSION_TOKEN="$(printf '%s' "$USER_LOGIN_JSON" | json_get session.token)"
printf '%s\n' "$USER_LOGIN_JSON"

echo "windows heartbeat"
request POST /api/v1/windows-agents/heartbeat "$WINDOWS_AGENT_TOKEN" \
  "{\"agentId\":\"$AGENT_ID\",\"agentName\":\"Smoke Windows\",\"hostname\":\"smoke\",\"adbVersion\":\"Android Debug Bridge smoke\",\"health\":{\"status\":\"warn\",\"reason\":\"smoke\",\"warnings\":[\"smoke_warning\"],\"adb\":{\"ok\":true,\"path\":\"adb\",\"version\":\"Android Debug Bridge smoke\"},\"directories\":{\"logDir\":{\"path\":\"/tmp\",\"ok\":true},\"cacheDir\":{\"path\":\"/tmp\",\"ok\":true}},\"lastScan\":{\"ok\":true,\"at\":\"smoke\",\"error\":\"\"}}}"
echo

echo "windows device sync"
request POST "/api/v1/windows-agents/$AGENT_ID/devices/sync" "$WINDOWS_AGENT_TOKEN" \
  "{\"devices\":[{\"adbSerial\":\"SMOKE123\",\"deviceId\":\"$DEVICE_ID\",\"state\":\"device\",\"model\":\"SmokePhone\",\"androidVersion\":\"14\"}]}"
echo

echo "windows health persisted"
WINDOWS_AGENTS_JSON="$(request GET /api/v1/windows-agents "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$WINDOWS_AGENTS_JSON"
if [ "$(printf '%s' "$WINDOWS_AGENTS_JSON" | json_agent_health_warning "$AGENT_ID")" != "smoke_warning" ]; then
  echo "expected windows health warning to persist"
  exit 1
fi
echo

echo "phone heartbeat"
request POST /api/v1/devices/heartbeat "$DEVICE_AGENT_TOKEN" \
  "{\"deviceId\":\"$DEVICE_ID\",\"deviceName\":\"Smoke Phone\",\"model\":\"SmokePhone\",\"androidVersion\":\"14\",\"appVersion\":\"smoke\"}"
echo

echo "bind smoke sim"
request PUT "/api/v1/devices/$DEVICE_ID/sims" "$ADMIN_SESSION_TOKEN" \
  "{\"sims\":[{\"subscriptionId\":0,\"slotIndex\":0,\"phoneNumber\":\"$SMOKE_PHONE\",\"carrierName\":\"Smoke\",\"enabled\":true}]}"
echo

echo "bind smoke xhs app2 only"
request PUT "/api/v1/devices/$DEVICE_ID/xhs-accounts" "$ADMIN_SESSION_TOKEN" \
  "{\"accounts\":[{\"appSlot\":\"app1\",\"label\":\"小红书\",\"accountName\":\"smoke-main\",\"enabled\":false},{\"appSlot\":\"app2\",\"label\":\"Ⅱ·小红书\",\"accountName\":\"smoke-clone\",\"enabled\":true}]}"
echo

echo "user phones"
USER_PHONES_JSON="$(request GET /api/v1/user/phones "$USER_SESSION_TOKEN")"
printf '%s\n' "$USER_PHONES_JSON"
if [ "$(printf '%s' "$USER_PHONES_JSON" | json_get phones.length)" = "0" ]; then
  echo "expected at least one available phone"
  exit 1
fi
echo

echo "user sms order"
SMS_ORDER_JSON="$(request POST /api/v1/user/sms-orders "$USER_SESSION_TOKEN" "{\"phoneNumber\":\"$SMOKE_PHONE\",\"platform\":\"小红书\"}")"
SMS_ORDER_ID="$(printf '%s' "$SMS_ORDER_JSON" | json_get order.orderId)"
printf '%s\n' "$SMS_ORDER_JSON"
echo

echo "user waiting sms limit"
SMS_LIMIT_STATUS="$(curl -s -o /tmp/phone-cloud-sms-limit.json -w '%{http_code}' -X POST "$SERVER_BASE_URL/api/v1/user/sms-orders" \
  -H "authorization: Bearer $USER_SESSION_TOKEN" \
  -H "content-type: application/json" \
  --data "{\"phoneNumber\":\"$SMOKE_PHONE\",\"platform\":\"小红书\"}")"
if [ "$SMS_LIMIT_STATUS" != "429" ]; then
  echo "expected 429 from waiting sms limit, got $SMS_LIMIT_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-sms-limit.json
echo

echo "phone reserved while sms waits"
USER_PHONES_JSON="$(request GET /api/v1/user/phones "$USER_SESSION_TOKEN")"
printf '%s\n' "$USER_PHONES_JSON"
if [ "$(printf '%s' "$USER_PHONES_JSON" | json_phone_present "$SMOKE_PHONE")" != "false" ]; then
  echo "expected reserved phone to be hidden while sms order waits"
  exit 1
fi
echo

echo "cancel user sms order"
request POST "/api/v1/user/sms-orders/$SMS_ORDER_ID/cancel" "$USER_SESSION_TOKEN" "{}"
echo

echo "phone released after sms cancel"
USER_PHONES_JSON="$(request GET /api/v1/user/phones "$USER_SESSION_TOKEN")"
printf '%s\n' "$USER_PHONES_JSON"
if [ "$(printf '%s' "$USER_PHONES_JSON" | json_phone_present "$SMOKE_PHONE")" != "true" ]; then
  echo "expected cancelled sms order to release phone"
  exit 1
fi
echo

echo "user sms order for matching"
MATCH_SMS_ORDER_JSON="$(request POST /api/v1/user/sms-orders "$USER_SESSION_TOKEN" \
  "{\"phoneNumber\":\"$SMOKE_PHONE\",\"platform\":\"小红书\"}"
)"
printf '%s\n' "$MATCH_SMS_ORDER_JSON"
echo

echo "stale sms does not match active order"
request POST /api/v1/sms-events "$DEVICE_AGENT_TOKEN" \
  "{\"deviceId\":\"$DEVICE_ID\",\"phoneNumber\":\"$SMOKE_PHONE\",\"subscriptionId\":0,\"slotIndex\":0,\"sender\":\"小红书\",\"body\":\"小红书验证码 000000\",\"receivedAt\":\"2000-01-01T00:00:00.000Z\",\"eventFingerprint\":\"stale-$STAMP\"}"
echo
USER_SMS_ORDERS_JSON="$(request GET /api/v1/user/sms-orders "$USER_SESSION_TOKEN")"
printf '%s\n' "$USER_SMS_ORDERS_JSON"
if [ "$(printf '%s' "$USER_SMS_ORDERS_JSON" | json_latest_sms_order_status)" != "waiting" ]; then
  echo "expected stale sms to leave latest order waiting"
  exit 1
fi
echo

echo "sms event"
SMS_EVENT_BODY="{\"deviceId\":\"$DEVICE_ID\",\"phoneNumber\":\"$SMOKE_PHONE\",\"subscriptionId\":0,\"slotIndex\":0,\"sender\":\"小红书\",\"body\":\"小红书验证码 123456\",\"eventFingerprint\":\"sms-$STAMP\"}"
request POST /api/v1/sms-events "$DEVICE_AGENT_TOKEN" "$SMS_EVENT_BODY"
echo

echo "duplicate sms event ignored"
DUPLICATE_SMS_STATUS="$(curl -s -o /tmp/phone-cloud-duplicate-sms.json -w '%{http_code}' -X POST "$SERVER_BASE_URL/api/v1/sms-events" \
  -H "authorization: Bearer $DEVICE_AGENT_TOKEN" \
  -H "content-type: application/json" \
  --data "$SMS_EVENT_BODY")"
if [ "$DUPLICATE_SMS_STATUS" != "200" ]; then
  echo "expected 200 from duplicate sms event, got $DUPLICATE_SMS_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-duplicate-sms.json
echo
SMS_EVENTS_JSON="$(request GET /api/v1/sms-events "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$SMS_EVENTS_JSON"
if [ "$(printf '%s' "$SMS_EVENTS_JSON" | json_get events.length)" != "2" ]; then
  echo "expected stale + first sms event only; duplicate must not be inserted"
  exit 1
fi
echo

echo "sms library batch"
SMS_LIBRARY_BODY="smslib-$STAMP"
request POST "/api/v1/devices/$DEVICE_ID/sms-library/batch" "$DEVICE_AGENT_TOKEN" \
  "{\"source\":\"smoke\",\"messages\":[{\"messageKey\":\"sms:smoke-$STAMP\",\"smsId\":\"smoke-$STAMP\",\"threadId\":\"thread-$STAMP\",\"box\":\"inbox\",\"type\":1,\"address\":\"10690000\",\"body\":\"$SMS_LIBRARY_BODY first\",\"messageAt\":\"2026-01-01T00:00:00.000Z\",\"subscriptionId\":0,\"slotIndex\":0}]}"
echo

echo "sms library batch duplicate update"
request POST "/api/v1/devices/$DEVICE_ID/sms-library/batch" "$DEVICE_AGENT_TOKEN" \
  "{\"source\":\"smoke\",\"messages\":[{\"messageKey\":\"sms:smoke-$STAMP\",\"smsId\":\"smoke-$STAMP\",\"threadId\":\"thread-$STAMP\",\"box\":\"inbox\",\"type\":1,\"address\":\"10690000\",\"body\":\"$SMS_LIBRARY_BODY updated\",\"messageAt\":\"2026-01-01T00:00:00.000Z\",\"subscriptionId\":0,\"slotIndex\":0}]}"
echo

SMS_LIBRARY_JSON="$(request GET "/api/v1/sms-library?deviceId=$DEVICE_ID&q=$SMS_LIBRARY_BODY" "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$SMS_LIBRARY_JSON"
if [ "$(printf '%s' "$SMS_LIBRARY_JSON" | json_get messages.length)" != "1" ]; then
  echo "expected exactly one sms library message after duplicate update"
  exit 1
fi
if [ "$(printf '%s' "$SMS_LIBRARY_JSON" | json_get messages.0.body)" != "$SMS_LIBRARY_BODY updated" ]; then
  echo "expected sms library duplicate to update body"
  exit 1
fi
echo

echo "user xhs task"
EMPTY_QR_STATUS="$(curl -s -o /tmp/phone-cloud-empty-qr.json -w '%{http_code}' -X POST "$SERVER_BASE_URL/api/v1/user/xhs/qr-scan-tasks" \
  -H "authorization: Bearer $USER_SESSION_TOKEN" \
  -H "content-type: application/json" \
  --data "{\"qrImageDataUrl\":\"\"}")"
if [ "$EMPTY_QR_STATUS" != "400" ]; then
  echo "expected 400 from empty xhs qr image, got $EMPTY_QR_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-empty-qr.json
echo

XHS_TASK_JSON="$(request POST /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN" "{\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}")"
XHS_TASK_ID="$(printf '%s' "$XHS_TASK_JSON" | json_get task.taskId)"
printf '%s\n' "$XHS_TASK_JSON"
if [ "$(printf '%s' "$XHS_TASK_JSON" | json_get task.xhsAppSlot)" != "app2" ]; then
  echo "expected user xhs task to target app2"
  exit 1
fi
echo

echo "cancel user xhs task"
request POST "/api/v1/user/xhs/qr-scan-tasks/$XHS_TASK_ID/cancel" "$USER_SESSION_TOKEN" "{}"
echo

echo "user xhs task trace"
TRACE_XHS_TASK_JSON="$(request POST /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN" \
  "{\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}"
)"
TRACE_XHS_TASK_ID="$(printf '%s' "$TRACE_XHS_TASK_JSON" | json_get task.taskId)"
printf '%s\n' "$TRACE_XHS_TASK_JSON"
if [ "$(printf '%s' "$TRACE_XHS_TASK_JSON" | json_get task.xhsAppSlot)" != "app2" ]; then
  echo "expected trace xhs task to target app2"
  exit 1
fi
echo

echo "device picks xhs command"
COMMAND_JSON="$(request GET "/api/v1/devices/$DEVICE_ID/commands/next" "$DEVICE_AGENT_TOKEN")"
COMMAND_ID="$(printf '%s' "$COMMAND_JSON" | json_get command.commandId)"
printf '%s\n' "$COMMAND_JSON"
if [ "$COMMAND_ID" != "$TRACE_XHS_TASK_ID" ]; then
  echo "expected device command $TRACE_XHS_TASK_ID, got $COMMAND_ID"
  exit 1
fi
if [ "$(printf '%s' "$COMMAND_JSON" | json_get command.payload.xhsAppSlot)" != "app2" ]; then
  echo "expected device command payload xhsAppSlot=app2"
  exit 1
fi
if [ "$(printf '%s' "$COMMAND_JSON" | json_get command.payload.workflowScript.engineVersion)" != "2" ]; then
  echo "expected device command workflowScript engineVersion=2"
  exit 1
fi
if [ "$(printf '%s' "$COMMAND_JSON" | json_get command.payload.workflowScript.version)" != "xhs-qr-login-v15" ]; then
  echo "expected default xhs workflow script v15"
  exit 1
fi
if [ "$(printf '%s' "$COMMAND_JSON" | json_get command.payload.workflowScript.steps.2.params.xhsAppSlot)" != "app2" ]; then
  echo "expected launchApp workflow step to target app2"
  exit 1
fi
if [ "$(printf '%s' "$COMMAND_JSON" | json_get command.payload.workflowScript.steps.7.assert.failMessage)" != "小红书当前未登录，无法进入扫码入口；请先在这台手机上登录小红书账号后重试" ]; then
  echo "expected open-profile workflow step to guard xhs login state"
  exit 1
fi
echo

echo "device checks running xhs command"
RUNNING_COMMAND_JSON="$(request GET "/api/v1/device-commands/$TRACE_XHS_TASK_ID" "$DEVICE_AGENT_TOKEN")"
printf '%s\n' "$RUNNING_COMMAND_JSON"
if [ "$(printf '%s' "$RUNNING_COMMAND_JSON" | json_get command.status)" != "running" ]; then
  echo "expected device command status running"
  exit 1
fi
echo

echo "device reports xhs trace event"
request POST "/api/v1/device-commands/$TRACE_XHS_TASK_ID/events" "$DEVICE_AGENT_TOKEN" \
  "{\"phase\":\"start\",\"level\":\"info\",\"stepIndex\":1,\"message\":\"smoke step started\",\"packageName\":\"com.xingin.xhs\"}"
echo

echo "cancel running xhs task"
request POST "/api/v1/user/xhs/qr-scan-tasks/$TRACE_XHS_TASK_ID/cancel" "$USER_SESSION_TOKEN" "{}"
echo

echo "device sees cancelled xhs command"
CANCELLED_COMMAND_JSON="$(request GET "/api/v1/device-commands/$TRACE_XHS_TASK_ID" "$DEVICE_AGENT_TOKEN")"
printf '%s\n' "$CANCELLED_COMMAND_JSON"
if [ "$(printf '%s' "$CANCELLED_COMMAND_JSON" | json_get command.status)" != "cancelled" ]; then
  echo "expected device command status cancelled"
  exit 1
fi
echo

echo "late device success ignored after cancel"
LATE_STATUS_JSON="$(request POST "/api/v1/device-commands/$TRACE_XHS_TASK_ID/status" "$DEVICE_AGENT_TOKEN" \
  "{\"status\":\"succeeded\",\"result\":{\"message\":\"late success\"}}"
)"
printf '%s\n' "$LATE_STATUS_JSON"
if [ "$(printf '%s' "$LATE_STATUS_JSON" | json_get ignored)" != "true" ]; then
  echo "expected late device status after cancel to be ignored"
  exit 1
fi
if [ "$(printf '%s' "$LATE_STATUS_JSON" | json_get command.status)" != "cancelled" ]; then
  echo "expected cancelled command to remain cancelled"
  exit 1
fi
echo

echo "user cancelled xhs remains cancelled"
CANCELLED_XHS_TASKS_JSON="$(request GET /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN")"
printf '%s\n' "$CANCELLED_XHS_TASKS_JSON"
if [ "$(printf '%s' "$CANCELLED_XHS_TASKS_JSON" | json_get tasks.0.status)" != "cancelled" ]; then
  echo "expected cancelled xhs task to remain cancelled"
  exit 1
fi
if [ "$(printf '%s' "$CANCELLED_XHS_TASKS_JSON" | json_get tasks.0.summary.eventCount)" != "1" ]; then
  echo "expected cancelled xhs task to keep trace event"
  exit 1
fi
echo

echo "user xhs task trace failure"
FAILED_XHS_TASK_JSON="$(request POST /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN" \
  "{\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}"
)"
FAILED_XHS_TASK_ID="$(printf '%s' "$FAILED_XHS_TASK_JSON" | json_get task.taskId)"
printf '%s\n' "$FAILED_XHS_TASK_JSON"
echo

echo "device picks failed xhs command"
FAILED_COMMAND_JSON="$(request GET "/api/v1/devices/$DEVICE_ID/commands/next" "$DEVICE_AGENT_TOKEN")"
FAILED_COMMAND_ID="$(printf '%s' "$FAILED_COMMAND_JSON" | json_get command.commandId)"
printf '%s\n' "$FAILED_COMMAND_JSON"
if [ "$FAILED_COMMAND_ID" != "$FAILED_XHS_TASK_ID" ]; then
  echo "expected failed device command $FAILED_XHS_TASK_ID, got $FAILED_COMMAND_ID"
  exit 1
fi
if [ "$(printf '%s' "$FAILED_COMMAND_JSON" | json_get command.payload.xhsAppSlot)" != "app2" ]; then
  echo "expected failed command payload xhsAppSlot=app2"
  exit 1
fi
if [ "$(printf '%s' "$FAILED_COMMAND_JSON" | json_get command.payload.workflowScript.engineVersion)" != "2" ]; then
  echo "expected failed command workflowScript engineVersion=2"
  exit 1
fi
echo

echo "device reports failed xhs trace event"
request POST "/api/v1/device-commands/$FAILED_XHS_TASK_ID/events" "$DEVICE_AGENT_TOKEN" \
  "{\"phase\":\"start\",\"level\":\"info\",\"stepIndex\":1,\"message\":\"smoke step started\",\"packageName\":\"com.xingin.xhs\"}"
echo

echo "device fails xhs command"
request POST "/api/v1/device-commands/$FAILED_XHS_TASK_ID/status" "$DEVICE_AGENT_TOKEN" \
  "{\"status\":\"failed\",\"result\":{\"message\":\"smoke failure\",\"action\":\"smoke step started\"}}"
echo

echo "user xhs trace summary"
USER_XHS_TASKS_JSON="$(request GET /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN")"
printf '%s\n' "$USER_XHS_TASKS_JSON"
if [ "$(printf '%s' "$USER_XHS_TASKS_JSON" | json_get tasks.0.summary.eventCount)" != "1" ]; then
  echo "expected user xhs summary eventCount=1"
  exit 1
fi
if [ "$(printf '%s' "$USER_XHS_TASKS_JSON" | json_get tasks.0.summary.failureMessage)" != "smoke failure" ]; then
  echo "expected user xhs failure summary"
  exit 1
fi
echo

echo "admin xhs trace summary"
ADMIN_XHS_TASKS_JSON="$(request GET /api/v1/xhs/qr-scan-tasks "$ADMIN_SESSION_TOKEN")"
printf '%s\n' "$ADMIN_XHS_TASKS_JSON"
if [ "$(printf '%s' "$ADMIN_XHS_TASKS_JSON" | json_get tasks.0.summary.lastEvent.message)" != "smoke step started" ]; then
  echo "expected admin xhs last event summary"
  exit 1
fi
if [ "$(printf '%s' "$ADMIN_XHS_TASKS_JSON" | json_get tasks.0.xhsAppSlot)" != "app2" ]; then
  echo "expected admin xhs list to show app2 slot"
  exit 1
fi
if [ -n "$(printf '%s' "$ADMIN_XHS_TASKS_JSON" | json_get tasks.0.qrImageDataUrl)" ]; then
  echo "admin xhs list must not include qrImageDataUrl"
  exit 1
fi
echo

echo "user xhs task for queue"
request POST /api/v1/user/xhs/qr-scan-tasks "$USER_SESSION_TOKEN" \
  "{\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}"
echo

echo "device xhs concurrency limit"
XHS_LIMIT_STATUS="$(curl -s -o /tmp/phone-cloud-xhs-limit.json -w '%{http_code}' -X POST "$SERVER_BASE_URL/api/v1/user/xhs/qr-scan-tasks" \
  -H "authorization: Bearer $USER_SESSION_TOKEN" \
  -H "content-type: application/json" \
  --data "{\"qrImageDataUrl\":\"$QR_IMAGE_DATA_URL\"}")"
if [ "$XHS_LIMIT_STATUS" != "409" ]; then
  echo "expected 409 from xhs device concurrency limit, got $XHS_LIMIT_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-xhs-limit.json
echo

echo "overview"
request GET /api/v1/overview "$ADMIN_SESSION_TOKEN"
echo

echo "maintenance prune dry run"
request POST /api/v1/maintenance/prune "$ADMIN_SESSION_TOKEN" "{\"dryRun\":true}"
echo

echo "maintenance prune"
request POST /api/v1/maintenance/prune "$ADMIN_SESSION_TOKEN" "{}"
echo

echo "disable smoke user"
request PUT "/api/v1/users/$SMOKE_USER_ID" "$ADMIN_SESSION_TOKEN" \
  "{\"enabled\":false}"
echo

echo "disabled user session rejected"
DISABLED_STATUS="$(curl -s -o /tmp/phone-cloud-disabled-user.json -w '%{http_code}' \
  -H "authorization: Bearer $USER_SESSION_TOKEN" \
  "$SERVER_BASE_URL/api/v1/user/phones")"
if [ "$DISABLED_STATUS" != "401" ]; then
  echo "expected 401 for disabled user session, got $DISABLED_STATUS"
  exit 1
fi
cat /tmp/phone-cloud-disabled-user.json
echo

echo "smoke test completed"
