import test from "node:test";
import assert from "node:assert/strict";
import { buildMigration, normalizeAccountName, parseAccountTable } from "./build-xhs-id-migration.mjs";

test("name normalization ignores whitespace and full-width forms", () => {
  assert.equal(normalizeAccountName(" 車 圈Ａ "), "車圈a");
});

test("migration follows ID when display name was changed", () => {
  const table = parseAccountTable([
    "1\t企业员工号\t旧昵称\t123456\t低调销冠改名：迪迪情报局\t\t\t\t\t\t118\t118"
  ].join("\n"));
  const report = buildMigration(table, [
    { deviceId: "adb:a", deviceName: "118", appSlot: "app1", accountName: "迪迪情报局" }
  ]);
  assert.deepEqual(report.summary, {
    platformBindings: 1,
    migrated: 1,
    movedDeviceMatches: 0,
    unresolved: 0,
    ambiguous: 0,
    duplicateIds: 0
  });
  assert.equal(report.migrated[0].xhsId, "123456");
});

test("migration follows a globally unique account alias when the phone assignment changed", () => {
  const table = parseAccountTable([
    "1\t企业专业号\t云梢2\t63082996580\t驰电车讯\t\t\t\t\t\t145\t145"
  ].join("\n"));
  const report = buildMigration(table, [
    { deviceId: "adb:fc122e9b", deviceName: "185", appSlot: "app1", accountName: "驰电车讯" }
  ]);

  assert.deepEqual(report.summary, {
    platformBindings: 1,
    migrated: 1,
    movedDeviceMatches: 1,
    unresolved: 0,
    ambiguous: 0,
    duplicateIds: 0
  });
  assert.equal(report.migrated[0].xhsId, "63082996580");
  assert.equal(report.migrated[0].tableDeviceName, "145");
  assert.equal(report.migrated[0].deviceName, "185");
  assert.equal(report.migrated[0].matchType, "unique_alias_moved_device");
});

test("migration blocks a moved-device fallback when the alias is not globally unique", () => {
  const table = parseAccountTable([
    "1\t企业专业号\tA\t111\t同名账号\t\t\t\t\t\t145\t145",
    "2\t企业专业号\tB\t222\t同名账号\t\t\t\t\t\t146\t146"
  ].join("\n"));
  const report = buildMigration(table, [
    { deviceId: "adb:new", deviceName: "185", appSlot: "app1", accountName: "同名账号" }
  ]);

  assert.equal(report.summary.migrated, 0);
  assert.equal(report.summary.ambiguous, 1);
  assert.equal(report.ambiguous[0].reason, "alias_matches_multiple_table_rows");
});
