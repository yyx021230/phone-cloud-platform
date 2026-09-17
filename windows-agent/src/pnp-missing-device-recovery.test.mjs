import assert from "node:assert/strict";
import test from "node:test";
import { createPnpMissingDeviceRecovery } from "./pnp-missing-device-recovery.mjs";

test("rescans first and targets only a repeatedly missing known device", () => {
  let clock = 0;
  const recovery = createPnpMissingDeviceRecovery({
    now: () => clock,
    rescanAfterMissingScans: 2,
    resetAfterMissingScans: 3,
    rescanCooldownMs: 1,
    resetCooldownMs: 1
  });
  recovery.observe({ devices: [{ adbSerial: "phone-1", state: "device" }] });
  clock += 2;
  assert.deepEqual(recovery.observe({ devices: [] }).rescanSerials, []);
  clock += 2;
  const second = recovery.observe({ devices: [] });
  assert.deepEqual(second.rescanSerials, ["phone-1"]);
  assert.deepEqual(second.resetSerials, []);
  recovery.markRescan();
  clock += 2;
  const third = recovery.observe({ devices: [] });
  assert.deepEqual(third.resetSerials, ["phone-1"]);
});

test("defers recovery while the agent has active phone work", () => {
  let clock = 0;
  const recovery = createPnpMissingDeviceRecovery({ now: () => clock, rescanAfterMissingScans: 1, resetAfterMissingScans: 1 });
  recovery.observe({ devices: [{ adbSerial: "phone-1", state: "device" }] });
  clock += 1;
  const result = recovery.observe({ devices: [], busy: true });
  assert.equal(result.deferredBusy, true);
  assert.deepEqual(result.rescanSerials, []);
  assert.deepEqual(result.resetSerials, []);
});

test("returns a recovered device to a clean state", () => {
  let clock = 0;
  const recovery = createPnpMissingDeviceRecovery({ now: () => clock, rescanAfterMissingScans: 1, resetAfterMissingScans: 1, resetCooldownMs: 10_000 });
  recovery.observe({ devices: [{ adbSerial: "phone-1", state: "device" }] });
  clock += 1;
  recovery.observe({ devices: [] });
  recovery.markReset("phone-1");
  clock += 1;
  recovery.observe({ devices: [{ adbSerial: "phone-1", state: "device" }] });
  clock += 1;
  const result = recovery.observe({ devices: [] });
  assert.deepEqual(result.resetSerials, ["phone-1"]);
});

test("retains a seeded phone and backs off when its USB device is not present", () => {
  let clock = 0;
  const recovery = createPnpMissingDeviceRecovery({
    now: () => clock,
    rescanAfterMissingScans: 1,
    resetAfterMissingScans: 1,
    resetCooldownMs: 10,
    absentRetryMs: 1_000,
    trackingWindowMs: 10_000
  });
  recovery.seed(["phone-1"]);
  clock += 1;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, ["phone-1"]);
  recovery.markReset("phone-1", { targetPresent: false });
  clock += 100;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, []);
  clock += 1_000;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, ["phone-1"]);
});

test("honors a longer per-device retry delay after an attempted recovery", () => {
  let clock = 0;
  const recovery = createPnpMissingDeviceRecovery({
    now: () => clock,
    rescanAfterMissingScans: 1,
    resetAfterMissingScans: 1,
    resetCooldownMs: 10,
    trackingWindowMs: 10_000
  });
  recovery.seed(["phone-1"]);
  clock += 1;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, ["phone-1"]);
  recovery.markReset("phone-1", { retryAfterMs: 500 });
  clock += 499;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, []);
  clock += 1;
  assert.deepEqual(recovery.observe({ devices: [] }).resetSerials, ["phone-1"]);
});

test("matches physical and ADB serials without case sensitivity", () => {
  const recovery = createPnpMissingDeviceRecovery({
    rescanAfterMissingScans: 1,
    resetAfterMissingScans: 1
  });
  recovery.seed(["E22124D1"]);
  const result = recovery.observe({ devices: [{ adbSerial: "e22124d1", state: "device" }] });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.resetSerials, []);
});
