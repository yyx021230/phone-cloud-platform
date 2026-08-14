import test from "node:test";
import assert from "node:assert/strict";
import { buildRecoveryQueue, createRecoveryEventJournal } from "./recovery-observability.mjs";

test("recovery journal records state transitions without flooding healthy startup", () => {
  let clock = Date.parse("2026-08-12T01:00:00.000Z");
  const journal = createRecoveryEventJournal({ now: () => clock });
  journal.observeTransitions([{ serial: "phone-1", state: "adb_device" }]);
  assert.equal(journal.events().length, 0);

  clock += 1_000;
  journal.observeTransitions([{ serial: "phone-1", state: "adb_offline" }]);
  clock += 1_000;
  journal.observeTransitions([{ serial: "phone-1", state: "adb_offline" }]);
  clock += 1_000;
  journal.observeTransitions([{ serial: "phone-1", state: "adb_device" }]);

  assert.deepEqual(journal.events().map((item) => item.type), ["state_changed", "recovered"]);
  assert.equal(journal.events()[0].previousState, "adb_device");
});

test("recovery journal deduplicates repeated safety deferrals and keeps a bounded history", () => {
  let clock = Date.parse("2026-08-12T02:00:00.000Z");
  const journal = createRecoveryEventJournal({ now: () => clock, limit: 20, dedupeWindowMs: 60_000 });
  journal.record({ type: "deferred", serial: "phone-2", reason: "target_busy" });
  clock += 5_000;
  journal.record({ type: "deferred", serial: "phone-2", reason: "target_busy" });
  assert.equal(journal.events().length, 1);

  for (let index = 0; index < 25; index += 1) {
    clock += 61_000;
    journal.record({ type: "status", serial: `phone-${index}`, reason: String(index) });
  }
  assert.equal(journal.events().length, 20);
  assert.equal(journal.events()[0].serial, "phone-5");
});

test("recovery queue exposes device identity, retry rail data and next action time", () => {
  const nextRetryAt = Date.parse("2026-08-12T03:05:00.000Z");
  const attempts = new Map([
    ["PHONE-152", { serial: "phone-152", attempts: 2, lastMode: "restart", lastAttemptAt: nextRetryAt - 30_000, nextRetryAt, targetType: "adb_interface" }]
  ]);
  const rows = buildRecoveryQueue({
    observations: [
      { serial: "phone-151", state: "adb_device", physicalPresent: true },
      { serial: "phone-152", state: "adb_interface_pnp_error", physicalPresent: true, physical: { adbInterfaceProblem: "CM_PROB_FAILED_START" } }
    ],
    attemptsBySerial: attempts,
    devices: [{ adbSerial: "phone-152", deviceId: "adb:phone-152", deviceName: "152" }],
    maxAttempts: 5
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    serial: "phone-152",
    deviceId: "adb:phone-152",
    deviceName: "152",
    state: "adb_interface_pnp_error",
    physicalPresent: true,
    attempts: 2,
    maxAttempts: 5,
    mode: "restart",
    lastAttemptAt: "2026-08-12T03:04:30.000Z",
    nextActionAt: "2026-08-12T03:05:00.000Z",
    inProgress: false,
    quarantined: false,
    quarantinedAt: "",
    targetType: "adb_interface",
    lastError: "",
    rootProblem: "",
    adbInterfaceProblem: "CM_PROB_FAILED_START"
  });
});

test("recovery queue prioritizes in-progress and quarantined devices", () => {
  const observations = ["phone-wait", "phone-quarantine", "phone-active"].map((serial) => ({
    serial,
    state: "usb_composite_no_adb_interface",
    physicalPresent: true
  }));
  const attempts = new Map([
    ["PHONE-ACTIVE", { attempts: 1, inProgress: true }],
    ["PHONE-QUARANTINE", { attempts: 5, quarantinedAt: Date.now() }]
  ]);
  const rows = buildRecoveryQueue({ observations, attemptsBySerial: attempts, maxAttempts: 5 });
  assert.deepEqual(rows.map((item) => item.serial), ["phone-active", "phone-quarantine", "phone-wait"]);
});

test("recovery queue excludes unplugged historical devices without active recovery state", () => {
  const rows = buildRecoveryQueue({
    observations: [
      { serial: "phone-unplugged", state: "physically_absent", physicalPresent: false },
      { serial: "phone-unknown", state: "inventory_unavailable", physicalPresent: false },
      { serial: "phone-mtp", state: "usb_present_mtp_only", physicalPresent: true },
      { serial: "phone-auth", state: "adb_unauthorized", physicalPresent: true }
    ]
  });
  assert.deepEqual(rows.map((item) => item.serial), ["phone-auth", "phone-mtp"]);
});

test("recovery queue excludes a currently screen-controlled phone", () => {
  const rows = buildRecoveryQueue({
    observations: [
      { serial: "phone-screen", state: "adb_offline", physicalPresent: true },
      { serial: "phone-idle", state: "usb_present_mtp_only", physicalPresent: true }
    ],
    excludedSerials: ["PHONE-SCREEN"]
  });
  assert.deepEqual(rows.map((item) => item.serial), ["phone-idle"]);
});
