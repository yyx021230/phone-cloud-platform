import assert from "node:assert/strict";
import test from "node:test";
import { applyXhsMigrationToDeviceRows, validateXhsMigrationReport } from "./apply-xhs-id-migration.mjs";

function report(migrated) {
  return {
    summary: {
      platformBindings: migrated.length,
      migrated: migrated.length,
      unresolved: 0,
      ambiguous: 0,
      duplicateIds: 0
    },
    migrated
  };
}

test("adds stable IDs atomically while preserving account display data", () => {
  const migration = report([
    { deviceId: "adb:a", appSlot: "app1", accountName: "账号 A", xhsId: "1001" },
    { deviceId: "adb:b", appSlot: "app2", accountName: "账号 B", xhsId: "1002" }
  ]);
  const result = applyXhsMigrationToDeviceRows([
    { device_id: "adb:a", data: { deviceName: "1", xhsAccounts: [{ appSlot: "app1", label: "小红书", accountName: "账号 A", enabled: true }] } },
    { device_id: "adb:b", data: { deviceName: "2", xhsAccounts: [{ appSlot: "app2", label: "Ⅱ·小红书", accountName: "账号 B", enabled: true }] } }
  ], migration);
  assert.deepEqual(result.summary, { configured: 2, matched: 2, changedDevices: 2, uniqueIds: 2 });
  assert.equal(result.rows[0].data.xhsAccounts[0].xhsId, "1001");
  assert.equal(result.rows[0].data.xhsAccounts[0].label, "小红书");
  assert.equal(result.rows[1].data.xhsAccounts[0].enabled, true);
});

test("rejects a report with a duplicate stable ID", () => {
  assert.throws(() => validateXhsMigrationReport(report([
    { deviceId: "adb:a", appSlot: "app1", accountName: "A", xhsId: "same" },
    { deviceId: "adb:b", appSlot: "app1", accountName: "B", xhsId: "SAME" }
  ])), /duplicate_id/);
});

test("rejects changed production bindings instead of partially applying", () => {
  assert.throws(() => applyXhsMigrationToDeviceRows([
    { device_id: "adb:a", data: { xhsAccounts: [{ appSlot: "app1", accountName: "renamed after preview" }] } }
  ], report([
    { deviceId: "adb:a", appSlot: "app1", accountName: "preview name", xhsId: "1001" }
  ])), /account_changed/);
});
