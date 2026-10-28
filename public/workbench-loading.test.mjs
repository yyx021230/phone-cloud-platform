import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");

function sourceFor(name) {
  return app.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("workbench preserves 30-second SMS and 3-second XHS task refresh cadences", () => {
  assert.match(app, /const USER_SMS_AUTO_REFRESH_MS = 30_000;/);
  assert.match(app, /const USER_XHS_TASK_REFRESH_MS = 3_000;/);
});

test("automatic SMS synchronization does not occupy the manual refresh control", () => {
  const automaticRefresh = sourceFor("autoRefreshCurrentUserSmsLibrary");
  assert.doesNotMatch(automaticRefresh, /state\.userSmsRefreshDeviceId\s*=\s*deviceId/);
  assert.doesNotMatch(automaticRefresh, /state\.userSmsRefreshCooldownUntil\s*=/);
  assert.match(automaticRefresh, /source: "sms_panel_open"/);
});

test("workbench loading cannot leave the initial inventory spinner running after a request fails", () => {
  const loader = sourceFor("loadAll");
  assert.match(loader, /if \(loadAllInFlight\) return;/);
  assert.match(loader, /state\.userDevicesLoading = false;/);
  assert.match(loader, /state\.userDevicesLoadError = error\.message \|\|/);
});

test("API calls have a finite timeout instead of waiting forever", () => {
  const api = sourceFor("api");
  assert.match(api, /AbortSignal\.timeout\(15_000\)/);
});
