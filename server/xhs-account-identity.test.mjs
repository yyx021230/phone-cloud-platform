import test from "node:test";
import assert from "node:assert/strict";
import { findXhsIdConflict, normalizeXhsId, validateXhsAccounts } from "./xhs-account-identity.mjs";

test("normalizeXhsId removes whitespace", () => {
  assert.equal(normalizeXhsId(" 12 34\n56 "), "123456");
});

test("account name requires an immutable Xiaohongshu ID", () => {
  assert.deepEqual(validateXhsAccounts([{ appSlot: "app1", accountName: "新名字", xhsId: "" }]), {
    error: "xhs_id_required",
    appSlot: "app1",
    accountName: "新名字"
  });
});

test("Xiaohongshu ID requires a display name", () => {
  assert.deepEqual(validateXhsAccounts([{ appSlot: "app1", accountName: "", xhsId: "123" }]), {
    error: "xhs_account_name_required",
    appSlot: "app1",
    xhsId: "123"
  });
});

test("one device cannot bind the same ID to both app slots", () => {
  assert.equal(validateXhsAccounts([
    { appSlot: "app1", accountName: "A", xhsId: "123" },
    { appSlot: "app2", accountName: "B", xhsId: "123" }
  ])?.error, "xhs_id_duplicate_on_device");
});

test("renaming an account does not bypass cross-device uniqueness", () => {
  const conflict = findXhsIdConflict([
    { deviceId: "phone-a", deviceName: "180", xhsAccounts: [{ appSlot: "app1", accountName: "旧名字", xhsId: "123" }] }
  ], "phone-b", [{ appSlot: "app2", accountName: "新名字", xhsId: "123" }]);
  assert.equal(conflict?.error, "xhs_id_already_bound");
  assert.equal(conflict?.conflictDeviceName, "180");
});

test("editing the account on its own device is allowed", () => {
  assert.equal(findXhsIdConflict([
    { deviceId: "phone-a", xhsAccounts: [{ appSlot: "app1", accountName: "旧名字", xhsId: "123" }] }
  ], "phone-a", [{ appSlot: "app1", accountName: "新名字", xhsId: "123" }]), null);
});
