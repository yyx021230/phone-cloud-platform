import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_USB_VENDOR_IDS,
  PNP_RECOVERY_POLICY_VERSION,
  isAdvancedPnpRecoveryMode,
  isDeferredPnpRecoveryPlan,
  normalizePnpRecoveryTargetState,
  orderPnpRecoveryTargets,
  planPnpRecoveryAction,
  pnpRecoveryActionBackoffMs,
  pnpTargetRecoveryBackoffMs,
  pnpTargetRecoveryMode,
  selectPnpRecoveryBatch
} from "./pnp-recovery-policy.mjs";

test("discovers the Android and Unisoc USB vendor ids used by current phones", () => {
  assert.equal(ANDROID_USB_VENDOR_IDS.includes("18D1"), true);
  assert.equal(ANDROID_USB_VENDOR_IDS.includes("1782"), true);
});

test("uses eight targeted restarts and then quarantines the phone", () => {
  assert.equal(pnpTargetRecoveryMode(1), "restart");
  assert.equal(pnpTargetRecoveryMode(2), "restart");
  assert.equal(pnpTargetRecoveryMode(5), "restart");
  assert.equal(pnpTargetRecoveryMode(8), "restart");
  assert.equal(pnpTargetRecoveryMode(9), "quarantine");
  assert.equal(pnpTargetRecoveryMode(6, 5), "quarantine");
});

test("resets persisted attempts when the state-driven policy version changes", () => {
  assert.deepEqual(normalizePnpRecoveryTargetState({ attempts: 8, quarantinedAt: 123 }, "phone-1"), {
    serial: "phone-1",
    policyVersion: PNP_RECOVERY_POLICY_VERSION,
    attempts: 0,
    actionHistory: [],
    lastMode: "",
    lastAttemptAt: 0,
    nextRetryAt: 0
  });
});

test("migrates repeated v2 ADB-child restarts into one v3 step without clearing other history", () => {
  assert.deepEqual(normalizePnpRecoveryTargetState({
    serial: "phone-1",
    policyVersion: 2,
    attempts: 5,
    actionHistory: [
      "restart_adb_interface",
      "cycle_usb_port",
      "restart_adb_interface",
      "restart_adb_interface",
      "restart_adb_interface"
    ],
    quarantinedAt: 123,
    nextRetryAt: 456,
    inProgress: true,
    lastMode: "system_adb_maintenance_required"
  }, "phone-1"), {
    serial: "phone-1",
    policyVersion: PNP_RECOVERY_POLICY_VERSION,
    attempts: 2,
    actionHistory: ["restart_adb_interface", "cycle_usb_port"],
    quarantinedAt: 0,
    nextRetryAt: 0,
    inProgress: false,
    lastMode: "cycle_usb_port"
  });
});

test("preserves v2 retry state which was not blocked by duplicate ADB-child restarts", () => {
  const normalized = normalizePnpRecoveryTargetState({
    serial: "phone-2",
    policyVersion: 2,
    attempts: 3,
    actionHistory: ["cycle_usb_port", "cycle_usb_port", "cycle_usb_port"],
    quarantinedAt: 789,
    lastMode: "cycle_usb_port"
  }, "phone-2");
  assert.equal(normalized.policyVersion, PNP_RECOVERY_POLICY_VERSION);
  assert.equal(normalized.attempts, 3);
  assert.deepEqual(normalized.actionHistory, ["cycle_usb_port", "cycle_usb_port", "cycle_usb_port"]);
  assert.equal(normalized.quarantinedAt, 789);
  assert.equal(normalized.lastMode, "cycle_usb_port");
});

test("reopens only v3 terminal states which gained a v4 exact recovery step", () => {
  const rootAdb = normalizePnpRecoveryTargetState({
    policyVersion: 3,
    attempts: 5,
    actionHistory: ["restart_adb_interface"],
    lastMode: "system_adb_maintenance_required",
    quarantinedAt: 123
  }, "phone-root-adb");
  const mtp = normalizePnpRecoveryTargetState({
    policyVersion: 3,
    attempts: 3,
    actionHistory: ["cycle_usb_port", "cycle_usb_port", "cycle_usb_port"],
    lastMode: "usb_gadget_adb_not_exposed",
    quarantinedAt: 456
  }, "phone-mtp");
  assert.equal(rootAdb.quarantinedAt, 0);
  assert.equal(rootAdb.attempts, 1);
  assert.equal(rootAdb.lastMode, "restart_adb_interface");
  assert.equal(planPnpRecoveryAction({
    observation: {
      state: "adb_interface_ready_transport_missing",
      physical: {
        rootInstanceId: "USB\\ROOT_ADB",
        adbInterfaceInstanceId: "usb\\root_adb",
        upstreamInstanceId: "USB\\UPSTREAM"
      }
    },
    previous: rootAdb,
    maxAttempts: 5
  }).mode, "recreate_adb_root");
  assert.equal(mtp.quarantinedAt, 0);
  assert.equal(mtp.attempts, 3);
  assert.equal(mtp.lastMode, "cycle_usb_port");
});

test("restarts a stale WinUSB ADB child once before recreating only that child", () => {
  const observation = {
    state: "adb_interface_ready_transport_missing",
    physical: {
      rootInstanceId: "USB\\PHONE",
      adbInterfaceInstanceId: "USB\\SUBCLASS_42&PROT_01\\CHILD",
      adbInterfaceKind: "generic_winusb_adb"
    }
  };
  const first = planPnpRecoveryAction({ observation, previous: { attempts: 0 } });
  const retry = planPnpRecoveryAction({ observation, previous: { attempts: 1, actionHistory: ["restart_adb_interface"] } });
  const secondRecreate = planPnpRecoveryAction({
    observation,
    previous: { attempts: 2, actionHistory: ["restart_adb_interface", "recreate_adb_interface"] }
  });
  const terminal = planPnpRecoveryAction({
    observation,
    previous: {
      attempts: 3,
      actionHistory: ["restart_adb_interface", "recreate_adb_interface", "recreate_adb_interface"]
    },
    maxAttempts: 5
  });
  assert.equal(first.mode, "restart_adb_interface");
  assert.equal(first.targetType, "generic_winusb_adb_interface");
  assert.equal(retry.mode, "recreate_adb_interface");
  assert.equal(retry.attempt, 2);
  assert.equal(retry.instanceId, observation.physical.adbInterfaceInstanceId);
  assert.equal(retry.scanInstanceId, observation.physical.rootInstanceId);
  assert.equal(secondRecreate.mode, "recreate_adb_interface");
  assert.equal(terminal.mode, "system_adb_maintenance_required");
  assert.equal(terminal.automatic, false);
});

test("rebuilds an exact ADB root after one restart when the interface is the phone root", () => {
  const observation = {
    state: "adb_interface_ready_transport_missing",
    physical: {
      rootInstanceId: "USB\\VID_2D95&PID_6001\\PHONE",
      adbInterfaceInstanceId: "usb\\vid_2d95&pid_6001\\phone",
      upstreamInstanceId: "USB\\HUB-A",
      adbInterfaceKind: "generic_winusb_adb"
    }
  };
  const first = planPnpRecoveryAction({ observation, previous: { attempts: 0, actionHistory: [] } });
  const second = planPnpRecoveryAction({
    observation,
    previous: { attempts: 1, actionHistory: ["restart_adb_interface"] }
  });
  assert.equal(first.mode, "restart_adb_interface");
  assert.equal(first.advanced, true);
  assert.equal(second.mode, "recreate_adb_root");
  assert.equal(second.instanceId, observation.physical.rootInstanceId);
  assert.equal(second.scanInstanceId, observation.physical.upstreamInstanceId);
  assert.equal(second.advanced, true);
});

test("rebuilds one exact Composite subtree only after an observed ADB child degrades to MTP-only", () => {
  const observation = {
    state: "usb_present_mtp_only",
    physical: {
      rootInstanceId: "USB\\PHONE",
      upstreamInstanceId: "USB\\EXACT_PARENT",
      hubInterfacePath: "\\\\?\\USB#HUB#{guid}",
      portNumber: 4
    }
  };
  const plan = planPnpRecoveryAction({
    observation,
    previous: { attempts: 1, actionHistory: ["restart_adb_interface"] }
  });
  assert.equal(plan.mode, "recreate_usb_composite");
  assert.equal(plan.targetType, "usb_composite");
  assert.equal(plan.instanceId, "USB\\PHONE");
  assert.equal(plan.scanInstanceId, "USB\\EXACT_PARENT");
  assert.equal(isAdvancedPnpRecoveryMode(plan.mode), true);
});

test("requires one exact port cycle before rebuilding a long-term MTP-only Composite", () => {
  const plan = planPnpRecoveryAction({
    observation: {
      state: "usb_present_mtp_only",
      physical: {
        rootInstanceId: "USB\\PHONE",
        upstreamInstanceId: "USB\\EXACT_PARENT",
        hubInterfacePath: "\\\\?\\USB#HUB#{guid}",
        portNumber: 4
      }
    },
    previous: { attempts: 0, actionHistory: [] }
  });
  assert.equal(plan.mode, "cycle_usb_port");
  assert.notEqual(plan.mode, "recreate_usb_composite");
});

test("upgrades an MTP-only phone from one exact port cycle to one Composite rebuild", () => {
  const observation = {
    state: "usb_present_mtp_only",
    physical: {
      rootInstanceId: "USB\\PHONE",
      upstreamInstanceId: "USB\\HUB",
      hubInterfacePath: "\\\\?\\USB#HUB#{guid}",
      portNumber: 4
    }
  };
  const modes = [];
  let previous = { attempts: 0, actionHistory: [] };
  for (let index = 0; index < 3; index += 1) {
    const plan = planPnpRecoveryAction({ observation, previous });
    modes.push(plan.mode);
    previous = {
      attempts: previous.attempts + (plan.automatic ? 1 : 0),
      actionHistory: plan.automatic ? [...previous.actionHistory, plan.mode] : previous.actionHistory
    };
  }
  assert.deepEqual(modes, [
    "cycle_usb_port",
    "recreate_usb_composite",
    "usb_gadget_adb_not_exposed"
  ]);
  assert.equal(isAdvancedPnpRecoveryMode(modes[0]), true);
  assert.equal(isAdvancedPnpRecoveryMode(modes[1]), true);
  assert.equal(isAdvancedPnpRecoveryMode(modes[2]), false);
});

test("does not jump to a destructive root action when exact port mapping is unavailable", () => {
  const observation = {
    state: "usb_present_mtp_only",
    physical: { rootInstanceId: "USB\\PHONE" }
  };
  const plan = planPnpRecoveryAction({ observation, previous: { attempts: 0, actionHistory: [] } });
  assert.equal(plan.mode, "await_exact_usb_mapping");
  assert.equal(plan.automatic, false);
  assert.equal(isDeferredPnpRecoveryPlan(plan), true);
});

test("does not wait forever when an unavailable port has already used its cycle budget", () => {
  const plan = planPnpRecoveryAction({
    observation: {
      state: "usb_present_mtp_only",
      physical: { rootInstanceId: "USB\\PHONE" }
    },
    previous: {
      attempts: 1,
      actionHistory: ["cycle_usb_port"]
    },
    maxAttempts: 5
  });
  assert.equal(plan.mode, "usb_gadget_adb_not_exposed");
  assert.equal(plan.terminal, true);
});

test("retries a broken USB root twice before bounded exact port cycles", () => {
  const observation = {
    state: "usb_root_pnp_error",
    physical: {
      rootInstanceId: "USB\\PHONE",
      upstreamInstanceId: "USB\\HUB",
      hubInterfacePath: "\\\\?\\USB#HUB#{guid}",
      portNumber: 4
    }
  };
  const first = planPnpRecoveryAction({ observation, previous: { attempts: 0, actionHistory: [] } });
  const second = planPnpRecoveryAction({ observation, previous: { attempts: 1, actionHistory: [first.mode] } });
  const third = planPnpRecoveryAction({ observation, previous: { attempts: 2, actionHistory: [first.mode, second.mode] } });
  assert.deepEqual([first.mode, second.mode, third.mode], ["restart_usb_root", "restart_usb_root", "cycle_usb_port"]);
});

test("preserves duplicate completed actions as retry counters", () => {
  const normalized = normalizePnpRecoveryTargetState({
    policyVersion: PNP_RECOVERY_POLICY_VERSION,
    attempts: 2,
    actionHistory: ["cycle_usb_port", "cycle_usb_port"]
  }, "phone-1");
  assert.deepEqual(normalized.actionHistory, ["cycle_usb_port", "cycle_usb_port"]);
});

test("uses a newly exposed ADB child even after an earlier root-stage action", () => {
  const plan = planPnpRecoveryAction({
    observation: {
      state: "adb_interface_ready_transport_missing",
      physical: { rootInstanceId: "USB\\PHONE", adbInterfaceInstanceId: "USB\\PHONE&MI_02" }
    },
    previous: { attempts: 1, actionHistory: ["restart_usb_root"] }
  });
  assert.equal(plan.mode, "restart_adb_interface");
  assert.equal(plan.attempt, 2);
});

test("backs off repeated targeted recovery attempts", () => {
  assert.equal(pnpTargetRecoveryBackoffMs(1, 30_000, 300_000), 30_000);
  assert.equal(pnpTargetRecoveryBackoffMs(2, 30_000, 300_000), 60_000);
  assert.equal(pnpTargetRecoveryBackoffMs(3, 30_000, 300_000), 120_000);
  assert.equal(pnpTargetRecoveryBackoffMs(4, 30_000, 300_000), 240_000);
  assert.equal(pnpTargetRecoveryBackoffMs(5, 30_000, 300_000), 300_000);
});

test("resets backoff when recovery advances to a different action layer", () => {
  const previous = {
    attempts: 3,
    actionHistory: ["cycle_usb_port", "cycle_usb_port", "restart_adb_interface"]
  };
  assert.equal(pnpRecoveryActionBackoffMs(previous, "cycle_usb_port", 30_000, 120_000), 120_000);
  assert.equal(pnpRecoveryActionBackoffMs(previous, "restart_adb_interface", 30_000, 120_000), 60_000);
  assert.equal(pnpRecoveryActionBackoffMs(previous, "recreate_adb_interface", 30_000, 120_000), 30_000);
});

test("does not increase action backoff for a command which never completed", () => {
  assert.equal(pnpRecoveryActionBackoffMs({ attempts: 4, actionHistory: [] }, "recreate_adb_interface", 30_000, 120_000), 30_000);
});

test("never-attempted phones are recovered before retrying earlier failures", () => {
  const attempts = new Map([
    ["PHONE-1", { attempts: 1, lastAttemptAt: 100 }],
    ["PHONE-2", { attempts: 2, lastAttemptAt: 50 }]
  ]);
  assert.deepEqual(
    orderPnpRecoveryTargets(["phone-2", "phone-1", "phone-3"], attempts),
    ["phone-3", "phone-1", "phone-2"]
  );
});

test("terminal telemetry cannot starve a runnable exact-port action", () => {
  const attempts = new Map([
    ["TERMINAL", normalizePnpRecoveryTargetState({ policyVersion: PNP_RECOVERY_POLICY_VERSION, attempts: 2 }, "terminal")]
  ]);
  const selected = selectPnpRecoveryBatch([
    { serial: "terminal", plan: { mode: "usb_gadget_adb_not_exposed", terminal: true, automatic: false } },
    { serial: "runnable", plan: { mode: "cycle_usb_port", terminal: false, automatic: true } }
  ], attempts, 8);
  assert.equal(selected[0].serial, "runnable");
});

test("a temporary mapping deferral cannot starve runnable work or consume an attempt", () => {
  const selected = selectPnpRecoveryBatch([
    { serial: "deferred", plan: { mode: "await_exact_usb_mapping", terminal: false, automatic: false, deferred: true } },
    { serial: "runnable", plan: { mode: "restart_adb_interface", terminal: false, automatic: true } }
  ], new Map(), 8);
  assert.equal(selected[0].serial, "runnable");
  assert.equal(selected[1].serial, "deferred");
});

test("runs at most one advanced rebuild for the same upstream in a batch", () => {
  const selected = selectPnpRecoveryBatch([
    { serial: "phone-1", plan: { mode: "recreate_usb_composite", terminal: false, automatic: true, advanced: true, scanInstanceId: "USB\\HUB-A" } },
    { serial: "phone-2", plan: { mode: "recreate_adb_root", terminal: false, automatic: true, advanced: true, scanInstanceId: "usb\\hub-a" } }
  ], new Map(), 8);
  assert.deepEqual(selected.map((item) => item.serial), ["phone-1"]);
});

test("runs advanced rebuilds concurrently only across different exact upstreams", () => {
  const selected = selectPnpRecoveryBatch([
    { serial: "phone-1", plan: { mode: "recreate_usb_composite", terminal: false, automatic: true, advanced: true, scanInstanceId: "USB\\HUB-A" } },
    { serial: "phone-2", plan: { mode: "recreate_adb_root", terminal: false, automatic: true, advanced: true, scanInstanceId: "USB\\HUB-B" } },
    { serial: "phone-3", plan: { mode: "cycle_usb_port", terminal: false, automatic: true, advanced: true, upstreamInstanceId: "USB\\HUB-C" } }
  ], new Map(), 8);
  assert.deepEqual(selected.map((item) => item.serial), ["phone-1", "phone-2", "phone-3"]);
});
