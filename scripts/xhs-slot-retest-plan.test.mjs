import test from "node:test";
import assert from "node:assert/strict";
import { boundXhsAccount, planXhsSlotRetest } from "./xhs-slot-retest-plan.mjs";

const device = (name, accounts) => ({ deviceName: name, deviceId: `fixture-${name}`,
  listed: true, listingStatus: "listed", adb: { serial: `fixture-serial-${name}`, state: "device" },
  automation: { xhsInstalled: true }, xhsAccounts: accounts });
const bound = (slot) => ({ appSlot: slot, enabled: true, xhsId: `fixture-${slot}` });
const plan = (devices, extra = {}) => planXhsSlotRetest(devices,
  { phoneNames: devices.map((d) => d.deviceName), ...extra });

test("6 has two enabled default slots and a device installed flag but no runnable account", () => {
  const rows = plan([device("6", [{ appSlot: "app1", enabled: true }, { appSlot: "app2", enabled: true }])]);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.eligible).length, 0);
});

test("13 only app2 and 43 only app1 never fall back to the opposite empty slot", () => {
  const rows = plan([device("13", [bound("app2")]), device("43", [bound("app1")])]);
  assert.deepEqual(rows.filter((r) => r.eligible).map((r) => `${r.name}/${r.slot}`), ["13/app2", "43/app1"]);
});

test("disabled, name-only and ambiguous slots do not authorize a run", () => {
  for (const accounts of [[{ ...bound("app1"), enabled: false }],
    [{ appSlot: "app1", accountName: "Fixture" }], [bound("app1"), bound("app1")]]) {
    assert.equal(boundXhsAccount(device("18", accounts), "app1"), null);
    assert.equal(plan([device("18", accounts)]).some((r) => r.eligible), false);
  }
});

test("a bound clone still needs its own package proof even if the device flag is false", () => {
  const d = device("25", [bound("app2")]);d.automation.xhsInstalled = false;
  const row = plan([d]).find((r) => r.eligible);
  assert.equal(row.slot, "app2");assert.equal(row.reason, "bound_slot_requires_package_proof");
});

test("offline, occupied, excluded, unlisted and duplicate devices cannot enter the plan", () => {
  const offline = device("75", [bound("app1")]);offline.adb.state = "usb_composite_no_adb_interface";
  const occupied = device("155", [bound("app2")]);occupied.occupancy = { kind: "screen_control" };
  const hidden = device("127", [bound("app1")]);hidden.listed = false;
  assert.equal(plan([offline, occupied, hidden, device("152", [bound("app1")])]).some((r) => r.eligible), false);
  assert.equal(plan([device("18", [bound("app1")])], { activeDeviceIds: ["fixture-18"] }).some((r) => r.eligible), false);
  assert.equal(plan([device("18", [bound("app1")]), device("18", [bound("app1")])]).some((r) => r.eligible), false);
});
