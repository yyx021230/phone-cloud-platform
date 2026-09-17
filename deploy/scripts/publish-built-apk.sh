#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_BASE_URL="${SERVER_BASE_URL:-http://127.0.0.1:8787}"
ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-dev-admin-token}"
VERSION_NAME="${VERSION_NAME:-0.1.0-phone-cloud}"
VERSION_CODE="${VERSION_CODE:-101}"
APK_PATH="${APK_PATH:-$ROOT_DIR/android-agent/SmsRelay/app/build/outputs/apk/debug/app-debug.apk}"

if [ ! -f "$APK_PATH" ]; then
  echo "APK not found: $APK_PATH" >&2
  echo "Run deploy/scripts/build-android-agent.sh first." >&2
  exit 1
fi

curl --fail --silent --show-error --noproxy '*' \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"versionName\":\"$VERSION_NAME\",\"versionCode\":$VERSION_CODE,\"releaseNotes\":\"Android Agent build\"}" \
  "$SERVER_BASE_URL/api/v1/app-release/latest" >/dev/null

curl --fail --silent --show-error --noproxy '*' \
  -X PUT \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary "@$APK_PATH" \
  "$SERVER_BASE_URL/api/v1/app-release/latest/apk?versionName=$VERSION_NAME&versionCode=$VERSION_CODE"

echo
echo "Published APK: $APK_PATH"
