import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_RECOVERY_STATES,
  buildDeviceRecoveryObservations,
  classifyDeviceRecoveryState,
  exactPnpRestartTarget,
  isAutomaticAdbTransportRecoveryState,
  isAutomaticPnpRecoveryState
} from "./device-recovery-state.mjs";

test("ADB authorization states are terminal diagnostics, not PnP candidates", () => {
  const physical = { rootInstanceId: "USB\\PHONE", adbInterfaceInstanceId: "USB\\PHONE&MI_02" };
  assert.equal(classifyDeviceRecoveryState({ adbState: "unauthorized", physical }), DEVICE_RECOVERY_STATES.ADB_UNAUTHORIZED);
  assert.equal(classifyDeviceRecoveryState({ adbState: "offline", physical }), DEVICE_RECOVERY_STATES.ADB_OFFLINE);
  assert.equal(isAutomaticPnpRecoveryState(DEVICE_RECOVERY_STATES.ADB_UNAUTHORIZED), false);
  assert.equal(isAutomaticPnpRecoveryState(DEVICE_RECOVERY_STATES.ADB_OFFLINE), false);
  assert.equal(isAutomaticAdbTransportRecoveryState(DEVICE_RECOVERY_STATES.ADB_UNAUTHORIZED), false);
  assert.equal(isAutomaticAdbTransportRecoveryState(DEVICE_RECOVERY_STATES.ADB_OFFLINE), true);
});

test("classifies the Windows USB and ADB interface layers independently", () => {
  assert.equal(classifyDeviceRecoveryState({ inventoryReady: false }), DEVICE_RECOVERY_STATES.INVENTORY_UNAVAILABLE);
  assert.equal(classifyDeviceRecoveryState({ physical: { fileCdPresent: true } }), DEVICE_RECOVERY_STATES.USB_PRESENT_MTP_ONLY);
  assert.equal(classifyDeviceRecoveryState({ physical: { rootInstanceId: "USB\\PHONE" } }), DEVICE_RECOVERY_STATES.USB_COMPOSITE_NO_ADB_INTERFACE);
  assert.equal(classifyDeviceRecoveryState({ physical: { rootProblem: "CM_PROB_FAILED_START" } }), DEVICE_RECOVERY_STATES.USB_ROOT_PNP_ERROR);
  assert.equal(classifyDeviceRecoveryState({ physical: { adbInterfaceInstanceId: "USB\\ADB", adbInterfaceProblem: "CM_PROB_WILL_BE_REMOVED" } }), DEVICE_RECOVERY_STATES.ADB_INTERFACE_PNP_ERROR);
  assert.equal(classifyDeviceRecoveryState({ physical: { adbInterfaceInstanceId: "USB\\ADB", adbInterfaceProblem: "CM_PROB_NONE" } }), DEVICE_RECOVERY_STATES.ADB_INTERFACE_READY_TRANSPORT_MISSING);
});

test("keeps ADB-visible devices physically present even when a vendor is absent from inventory", () => {
  const [observation] = buildDeviceRecoveryObservations({
    devices: [{ adbSerial: "unknown-vendor", state: "offline" }],
    inventory: []
  });
  assert.equal(observation.physicalPresent, true);
  assert.equal(observation.inventoryPresent, false);
  assert.equal(observation.state, DEVICE_RECOVERY_STATES.ADB_OFFLINE);
});

test("prefers restarting the ADB child and otherwise targets only the phone root", () => {
  const child = exactPnpRestartTarget({
    state: DEVICE_RECOVERY_STATES.ADB_INTERFACE_READY_TRANSPORT_MISSING,
    physical: { rootInstanceId: "USB\\PHONE", adbInterfaceInstanceId: "USB\\PHONE&MI_02" }
  });
  assert.deepEqual(child, { instanceId: "USB\\PHONE&MI_02", targetType: "adb_interface" });
  const root = exactPnpRestartTarget({
    state: DEVICE_RECOVERY_STATES.USB_PRESENT_MTP_ONLY,
    physical: { rootInstanceId: "USB\\PHONE" }
  });
  assert.deepEqual(root, { instanceId: "USB\\PHONE", targetType: "usb_root" });
});

test("joins ADB, physical and cached serials case-insensitively", () => {
  const observations = buildDeviceRecoveryObservations({
    devices: [{ adbSerial: "Phone-1", state: "device" }, { adbSerial: "PHONE-2", state: "unauthorized" }],
    inventory: [{ serial: "phone-1", rootInstanceId: "USB\\ONE" }, { serial: "phone-3", fileCdPresent: true }],
    knownSerials: ["phone-4"]
  });
  assert.deepEqual(observations.map((item) => [item.key, item.state]), [
    ["PHONE-1", DEVICE_RECOVERY_STATES.ADB_DEVICE],
    ["PHONE-2", DEVICE_RECOVERY_STATES.ADB_UNAUTHORIZED],
    ["PHONE-3", DEVICE_RECOVERY_STATES.USB_PRESENT_MTP_ONLY],
    ["PHONE-4", DEVICE_RECOVERY_STATES.PHYSICALLY_ABSENT]
  ]);
});
