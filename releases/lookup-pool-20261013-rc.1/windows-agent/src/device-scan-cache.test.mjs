import assert from "node:assert/strict";
import test from "node:test";
import { cachedAdbSerials, indexCachedDevices, mergeCachedDeviceScanRow } from "./device-scan-cache.mjs";

test("reuses static and SIM data reported by the server after an Agent restart", () => {
  const row = { adbSerial: "phone-1", state: "device", model: "PHJ110", product: "PHJ110H1" };
  const serverDevice = {
    deviceId: "adb:phone-1",
    deviceName: "152",
    model: "PHJ110",
    manufacturer: "OPPO",
    brand: "OPPO",
    androidVersion: "13",
    batteryLevel: 100,
    sims: [{ slotIndex: 0, phoneNumber: "18627591004" }]
  };

  const merged = mergeCachedDeviceScanRow(row, {}, serverDevice);

  assert.equal(merged.deviceName, "152");
  assert.equal(merged.manufacturer, "OPPO");
  assert.equal(merged.brand, "OPPO");
  assert.equal(merged.androidVersion, "13");
  assert.equal(merged.batteryLevel, 100);
  assert.deepEqual(merged.sims, serverDevice.sims);
});

test("keeps fresher in-process scan values ahead of server cache", () => {
  const merged = mergeCachedDeviceScanRow(
    { adbSerial: "phone-1", state: "device", model: "new-model" },
    { deviceName: "local-name", manufacturer: "local-maker", sims: [{ slotIndex: 1 }] },
    { deviceName: "server-name", manufacturer: "server-maker", sims: [{ slotIndex: 0 }] }
  );

  assert.equal(merged.model, "new-model");
  assert.equal(merged.deviceName, "local-name");
  assert.equal(merged.manufacturer, "local-maker");
  assert.deepEqual(merged.sims, [{ slotIndex: 1 }]);
});

test("indexes persisted device records by device id", () => {
  const indexed = indexCachedDevices([
    { deviceId: "adb:phone-1", deviceName: "152" },
    { deviceName: "missing-id" },
    null
  ]);

  assert.equal(indexed.size, 1);
  assert.equal(indexed.get("adb:phone-1").deviceName, "152");
});

test("identifies cached ADB serials so existing devices are not re-probed for SIM data", () => {
  const indexed = indexCachedDevices([
    { deviceId: "adb:phone-1" },
    { deviceId: "legacy:phone-2" }
  ]);

  assert.deepEqual(cachedAdbSerials(indexed), ["phone-1"]);
});
