import assert from "node:assert/strict";
import test from "node:test";

import { createPnpRecoverySafety } from "./pnp-recovery-safety.mjs";

function rows({ online = 0, missing = 0, unauthorized = 0, offline = 0 } = {}) {
  return [
    ...Array.from({ length: online }, (_, index) => ({ serial: `online-${index}`, state: "adb_device", physicalPresent: true })),
    ...Array.from({ length: missing }, (_, index) => ({ serial: `missing-${index}`, state: "adb_interface_ready_transport_missing", physicalPresent: true })),
    ...Array.from({ length: unauthorized }, (_, index) => ({ serial: `unauthorized-${index}`, state: "adb_unauthorized", physicalPresent: true })),
    ...Array.from({ length: offline }, (_, index) => ({ serial: `offline-${index}`, state: "adb_offline", physicalPresent: true }))
  ];
}

test("opens a circuit instead of mutating a batch outage", () => {
  const safety = createPnpRecoverySafety({ massOutageMinDevices: 4, massOutageRatio: 0.08 });
  const result = safety.observe(rows({ online: 96, missing: 4 }));
  assert.equal(result.circuitOpen, true);
  assert.equal(result.circuitReason, "mass_outage");
  assert.equal(result.canMutate, false);
});

test("moves a stable batch incident into degraded serial recovery instead of renewing forever", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({
    now: () => clock,
    massOutageMinDevices: 4,
    circuitCooldownMs: 100,
    stableScansToClose: 2
  });
  const opened = safety.observe(rows({ online: 96, missing: 4 }));
  const originalDeadline = opened.circuitUntil;
  clock = 50;
  const stableBeforeDeadline = safety.observe(rows({ online: 96, missing: 4 }));
  assert.equal(stableBeforeDeadline.circuitUntil, originalDeadline);
  clock = 101;
  const degraded = safety.observe(rows({ online: 96, missing: 4 }));
  assert.equal(degraded.circuitOpen, false);
  assert.equal(degraded.recoveryMode, "degraded_recovery");
  assert.equal(degraded.acknowledgedActionableCount, 4);
  assert.equal(degraded.canMutate, true);
});

test("re-opens immediately when another online phone drops during degraded recovery", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({
    now: () => clock,
    massOutageMinDevices: 4,
    circuitCooldownMs: 100,
    stableScansToClose: 1
  });
  safety.observe(rows({ online: 96, missing: 4 }));
  clock = 101;
  assert.equal(safety.observe(rows({ online: 96, missing: 4 })).circuitOpen, false);
  clock = 102;
  const result = safety.observe(rows({ online: 95, missing: 5 }));
  assert.equal(result.circuitOpen, true);
  assert.equal(result.circuitReason, "burst_outage");
  assert.equal(result.newlyLostCount, 1);
});

test("keeps a collateral-loss circuit open until every external phone is stably back", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({
    now: () => clock,
    circuitCooldownMs: 100,
    stableScansToClose: 2,
    massOutageMinDevices: 4
  });
  safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_device", physicalPresent: true }
  ]);
  safety.recordFailure("burst_outage", {
    batchTargets: ["target"],
    collateralLosses: ["collateral"]
  });

  clock = 101;
  let result = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_interface_ready_transport_missing", physicalPresent: true }
  ]);
  assert.equal(result.circuitOpen, true);
  assert.equal(result.stableScans, 0);
  assert.deepEqual(result.rescueSerials, ["COLLATERAL"]);
  assert.equal(result.rescueCanMutate, true);
  assert.equal(result.canMutate, false);

  clock = 102;
  result = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_device", physicalPresent: true }
  ]);
  assert.equal(result.circuitOpen, true);
  assert.equal(result.stableScans, 1);

  clock = 103;
  result = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_device", physicalPresent: true }
  ]);
  assert.equal(result.circuitOpen, false);
  assert.deepEqual(result.rescueSerials, []);
});

test("never opens the rescue lane for unauthorized collateral or stale inventory", () => {
  const safety = createPnpRecoverySafety({ circuitCooldownMs: 100, stableScansToClose: 2 });
  safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_device", physicalPresent: true }
  ]);
  safety.recordFailure("burst_outage", { batchTargets: ["target"], collateralLosses: ["collateral"] });

  const unauthorized = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_unauthorized", physicalPresent: true }
  ]);
  assert.deepEqual(unauthorized.rescueSerials, []);
  assert.equal(unauthorized.rescueCanMutate, false);

  const unavailable = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "collateral", state: "adb_interface_ready_transport_missing", physicalPresent: true }
  ], { inventoryReady: false });
  assert.deepEqual(unavailable.rescueSerials, ["COLLATERAL"]);
  assert.equal(unavailable.rescueCanMutate, false);
});

test("paces host-wide recovery actions even after the circuit is closed", () => {
  let clock = 1_000;
  const safety = createPnpRecoverySafety({ now: () => clock, minimumActionIntervalMs: 30_000 });
  safety.observe(rows({ online: 10, missing: 1 }));
  safety.recordAction();
  clock += 10_000;
  assert.equal(safety.observe(rows({ online: 10, missing: 1 })).blockedReason, "action_cooldown");
  clock += 20_001;
  assert.equal(safety.observe(rows({ online: 10, missing: 1 })).blockedReason, "");
});

test("treats a batch of offline ADB transports as a circuit-breaker incident", () => {
  const safety = createPnpRecoverySafety({ massOutageMinDevices: 4, massOutageRatio: 0.08 });
  const result = safety.observe(rows({ online: 96, offline: 4 }));
  assert.equal(result.circuitOpen, true);
  assert.equal(result.actionableCount, 4);
});

test("does not count unauthorized phones as automatic PnP failures", () => {
  const safety = createPnpRecoverySafety();
  const result = safety.observe(rows({ online: 95, unauthorized: 10 }));
  assert.equal(result.actionableCount, 0);
  assert.equal(result.unauthorizedCount, 10);
  assert.equal(result.circuitOpen, false);
});

test("excludes a screen-controlled phone from recovery candidates but still observes its ADB loss", () => {
  const safety = createPnpRecoverySafety({ massOutageMinDevices: 4 });
  const healthy = Array.from({ length: 9 }, (_, index) => ({ serial: `healthy-${index}`, state: "adb_device", physicalPresent: true }));
  safety.observe([...healthy, { serial: "phone-screen", state: "adb_device", physicalPresent: true }]);
  const result = safety.observe([
    ...healthy,
    { serial: "phone-screen", state: "adb_offline", physicalPresent: true }
  ], { ignoredSerials: ["PHONE-SCREEN"] });
  assert.equal(result.actionableCount, 0);
  assert.equal(result.newlyLostCount, 1);
  assert.equal(result.circuitOpen, false);
});

test("turns a delayed loss of a screen-controlled phone into post-action collateral", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({
    now: () => clock,
    massOutageMinDevices: 4,
    postActionWatchMs: 180
  });
  const baseline = [
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-screen", state: "adb_device", physicalPresent: true },
    { serial: "phone-steady", state: "adb_device", physicalPresent: true }
  ];
  safety.observe(baseline, { ignoredSerials: ["phone-screen"] });
  safety.beginPostActionWatch({
    onlineSerials: ["phone-screen", "phone-steady"],
    actionedSerials: ["target"]
  });

  clock = 120;
  const result = safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-screen", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_device", physicalPresent: true }
  ], { ignoredSerials: ["phone-screen"] });

  assert.equal(result.circuitOpen, true);
  assert.equal(result.circuitReason, "burst_outage");
  assert.equal(result.newlyLostCount, 1);
  assert.deepEqual(safety.snapshot().circuit.detail.collateralLosses, ["PHONE-SCREEN"]);
  assert.deepEqual(result.rescueSerials, []);
});

test("blocks another PnP mutation until the post-action observation window expires", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({ now: () => clock, postActionWatchMs: 180 });
  const baseline = [
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_device", physicalPresent: true }
  ];
  safety.observe(baseline);
  safety.beginPostActionWatch({
    onlineSerials: ["phone-steady"],
    actionedSerials: ["target"]
  });

  clock = 120;
  let result = safety.observe(baseline);
  assert.equal(result.blockedReason, "post_action_stability_window");
  assert.equal(result.canMutate, false);
  assert.equal(result.postActionWatchCount, 1);

  clock = 181;
  result = safety.observe(baseline);
  assert.equal(result.blockedReason, "");
  assert.equal(result.canMutate, true);
  assert.equal(result.postActionWatchCount, 0);
});

test("persists the post-action observation window across an Agent restart", () => {
  let clock = 1_000;
  const first = createPnpRecoverySafety({ now: () => clock, postActionWatchMs: 180 });
  first.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_device", physicalPresent: true }
  ]);
  first.beginPostActionWatch({ onlineSerials: ["phone-steady"], actionedSerials: ["target"] });

  clock = 1_100;
  const restored = createPnpRecoverySafety({
    now: () => clock,
    postActionWatchMs: 180,
    initialState: first.snapshot()
  });
  const result = restored.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_interface_ready_transport_missing", physicalPresent: true }
  ]);
  assert.equal(result.circuitOpen, true);
  assert.deepEqual(restored.snapshot().circuit.detail.collateralLosses, ["PHONE-STEADY"]);
});

test("preserves delayed collateral evidence when a later PnP action failure is recorded", () => {
  let clock = 1_000;
  const safety = createPnpRecoverySafety({ now: () => clock, postActionWatchMs: 180 });
  safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_device", physicalPresent: true }
  ]);
  safety.beginPostActionWatch({ onlineSerials: ["phone-steady"], actionedSerials: ["target"] });

  clock = 1_100;
  safety.observe([
    { serial: "target", state: "adb_interface_ready_transport_missing", physicalPresent: true },
    { serial: "phone-steady", state: "adb_interface_ready_transport_missing", physicalPresent: true }
  ]);
  safety.recordFailure("pnp_action_failed", { failedSerial: "target-2" });

  assert.deepEqual(safety.snapshot().circuit.detail.collateralLosses, ["PHONE-STEADY"]);
  assert.equal(safety.snapshot().circuit.detail.failedSerial, "target-2");
});

test("accepts a Set of screen-controlled serials from the live Agent", () => {
  const safety = createPnpRecoverySafety({ massOutageMinDevices: 2 });
  const health = safety.observe([
    { serial: "phone-screen", state: "usb_present_mtp_only", physicalPresent: true },
    { serial: "phone-other", state: "usb_present_mtp_only", physicalPresent: true }
  ], { ignoredSerials: new Set(["phone-screen"]), inventoryReady: true });

  assert.equal(health.actionableCount, 1);
  assert.deepEqual(health.actionable.map((item) => item.serial), ["phone-other"]);
});

test("opens the circuit when several previously-online phones disappear together", () => {
  const safety = createPnpRecoverySafety({ massOutageMinDevices: 4 });
  safety.observe(rows({ online: 10 }));
  const result = safety.observe(rows({ online: 6, unauthorized: 4 }));
  assert.equal(result.circuitOpen, true);
  assert.equal(result.circuitReason, "burst_outage");
  assert.equal(result.actionableCount, 0);
  assert.equal(result.newlyLostCount, 4);
});

test("keeps a timed-out PnP action circuit open until cooldown and stable scans", () => {
  let clock = 0;
  const safety = createPnpRecoverySafety({ now: () => clock, circuitCooldownMs: 100, stableScansToClose: 2 });
  safety.recordFailure("pnp_timeout");
  assert.equal(safety.observe(rows({ online: 2 })).circuitOpen, true);
  clock = 101;
  assert.equal(safety.observe(rows({ online: 2 })).circuitOpen, false);
});

test("enforces a host-wide automatic action budget", () => {
  const safety = createPnpRecoverySafety({ maxActionsPerHour: 2 });
  safety.recordAction();
  safety.recordAction();
  const result = safety.observe(rows({ online: 10, missing: 1 }));
  assert.equal(result.blockedReason, "hourly_budget_exhausted");
  assert.equal(result.canMutate, false);
});

test("never mutates when the physical USB inventory is unavailable", () => {
  const safety = createPnpRecoverySafety();
  const result = safety.observe(rows({ online: 10, missing: 1 }), { inventoryReady: false });
  assert.equal(result.blockedReason, "physical_inventory_unavailable");
  assert.equal(result.canMutate, false);
});
