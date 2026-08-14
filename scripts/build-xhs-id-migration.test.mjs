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
    unresolved: 0,
    ambiguous: 0,
    duplicateIds: 0
  });
  assert.equal(report.migrated[0].xhsId, "123456");
});
