import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createUserDeviceInventoryGuard, requireUserDeviceInventory } from "./user-device-inventory.js";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");

function sourceFor(name) {
  return app.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || "";
}

test("SMS inventory refresh stays at 30 seconds while active automation status refreshes at 3 seconds", () => {
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

test("device inventory is not rejected when an auxiliary workbench response is truncated", () => {
  const loader = sourceFor("loadAll");
  assert.match(loader, /const auxiliaryRequests = Promise\.allSettled\(/);
  assert.match(loader, /devices = await loadStableUserDeviceInventory\(\)/);
  assert.match(loader, /state\.userDevices = devices\.devices \|\| \[\];/);
  assert.match(loader, /renderUserWorkbench\(\);\s+const \[phones, orders, xhs, publish, lookup\] = await auxiliaryRequests;/);
  assert.doesNotMatch(loader, /\[devices, phones, orders, xhs, publish, lookup\] = await Promise\.all/);
});

test("the large QR task list is only loaded while the scan panel is open", () => {
  const fastRefresh = app.match(/function shouldFastRefreshUserXhsTasks\(\)[\s\S]*?\n\}/)?.[0] || "";
  const loader = sourceFor("loadAll");
  assert.match(fastRefresh, /return isUserScanPanelActive\(\);/);
  assert.match(loader, /shouldLoadXhsTasks \? api\("\/api\/v1\/user\/xhs\/qr-scan-tasks"\) : Promise\.resolve\(null\)/);
});

test("QR task polling is single-flight and preserves the other task source on partial failure", () => {
  const refresh = sourceFor("refreshUserXhsTasksOnly");
  assert.match(app, /let userAutomationRefreshPromise = null;/);
  assert.match(refresh, /if \(userAutomationRefreshPromise\) return userAutomationRefreshPromise;/);
  assert.match(refresh, /Promise\.allSettled\(/);
  assert.match(refresh, /userAutomationRefreshPromise = null;/);
});

test("API calls have a finite timeout instead of waiting forever", () => {
  const api = sourceFor("api");
  assert.match(api, /AbortSignal\.timeout\(15_000\)/);
});

test("a successful response with invalid JSON cannot become an empty device inventory", () => {
  const api = sourceFor("api");
  assert.match(api, /invalid_json_response/);
  assert.doesNotMatch(api, /response\.json\(\)\.catch\(\(\) => \(\{\}\)\)/);
  assert.throws(() => requireUserDeviceInventory({}), (error) => error.code === "invalid_user_device_inventory");
});

test("one transient empty inventory preserves the selected device until a later cycle confirms it", () => {
  const guard = createUserDeviceInventoryGuard({ emptyConfirmationCycles: 2 });
  const previous = [{ deviceId: "device-153" }, { deviceId: "device-154" }];
  assert.deepEqual(guard.decide(previous, []), {
    apply: false,
    devices: previous,
    reason: "unconfirmed_empty",
    confirmationCycle: 1
  });
  assert.deepEqual(guard.decide(previous, []), {
    apply: true,
    devices: [],
    reason: "confirmed_empty"
  });
});

test("a recovered retry immediately resets the empty-inventory guard", () => {
  const guard = createUserDeviceInventoryGuard({ emptyConfirmationCycles: 2 });
  const previous = [{ deviceId: "device-153" }];
  assert.equal(guard.decide(previous, []).apply, false);
  assert.equal(guard.decide(previous, [{ deviceId: "device-153" }]).reason, "non_empty");
  assert.equal(guard.decide(previous, []).confirmationCycle, 1);
  assert.match(app, /loadStableUserDeviceInventory\(\)/);
  assert.match(app, /本次刷新异常，正在显示上次有效清单/);
});
