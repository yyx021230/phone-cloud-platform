const PNP_OK_VALUES = new Set(["", "0", "CM_PROB_NONE", "NONE", "OK"]);

export const DEVICE_RECOVERY_STATES = Object.freeze({
  INVENTORY_UNAVAILABLE: "inventory_unavailable",
  PHYSICALLY_ABSENT: "physically_absent",
  USB_PRESENT_MTP_ONLY: "usb_present_mtp_only",
  USB_COMPOSITE_NO_ADB_INTERFACE: "usb_composite_no_adb_interface",
  USB_ROOT_PNP_ERROR: "usb_root_pnp_error",
  ADB_INTERFACE_PNP_ERROR: "adb_interface_pnp_error",
  ADB_INTERFACE_READY_TRANSPORT_MISSING: "adb_interface_ready_transport_missing",
  ADB_UNAUTHORIZED: "adb_unauthorized",
  ADB_OFFLINE: "adb_offline",
  ADB_DEVICE: "adb_device"
});

export function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

export function pnpProblemPresent(value) {
  return !PNP_OK_VALUES.has(String(value || "").trim().toUpperCase());
}

export function classifyDeviceRecoveryState({ adbState = "", physical = null, inventoryReady = true } = {}) {
  const normalizedAdbState = String(adbState || "").trim().toLowerCase();
  if (normalizedAdbState === "device") return DEVICE_RECOVERY_STATES.ADB_DEVICE;
  if (normalizedAdbState === "unauthorized") return DEVICE_RECOVERY_STATES.ADB_UNAUTHORIZED;
  if (normalizedAdbState === "offline") return DEVICE_RECOVERY_STATES.ADB_OFFLINE;
  if (!inventoryReady) return DEVICE_RECOVERY_STATES.INVENTORY_UNAVAILABLE;
  if (!physical) return DEVICE_RECOVERY_STATES.PHYSICALLY_ABSENT;
  if (pnpProblemPresent(physical.rootProblem)) return DEVICE_RECOVERY_STATES.USB_ROOT_PNP_ERROR;
  if (physical.adbInterfaceInstanceId) {
    return pnpProblemPresent(physical.adbInterfaceProblem)
      ? DEVICE_RECOVERY_STATES.ADB_INTERFACE_PNP_ERROR
      : DEVICE_RECOVERY_STATES.ADB_INTERFACE_READY_TRANSPORT_MISSING;
  }
  if (physical.fileCdPresent || physical.mtpPresent) return DEVICE_RECOVERY_STATES.USB_PRESENT_MTP_ONLY;
  return DEVICE_RECOVERY_STATES.USB_COMPOSITE_NO_ADB_INTERFACE;
}

export function buildDeviceRecoveryObservations({ devices = [], inventory = [], knownSerials = [], inventoryReady = true } = {}) {
  const adbBySerial = new Map();
  const physicalBySerial = new Map();
  const originalSerialByKey = new Map();

  for (const device of Array.isArray(devices) ? devices : []) {
    const serial = String(device?.adbSerial || device?.serial || "").trim();
    const key = normalizeSerial(serial);
    if (!key) continue;
    originalSerialByKey.set(key, serial);
    adbBySerial.set(key, device);
  }
  for (const item of Array.isArray(inventory) ? inventory : []) {
    const serial = String(item?.serial || "").trim();
    const key = normalizeSerial(serial);
    if (!key) continue;
    originalSerialByKey.set(key, serial);
    physicalBySerial.set(key, item);
  }
  for (const value of Array.isArray(knownSerials) ? knownSerials : []) {
    const serial = String(value || "").trim();
    const key = normalizeSerial(serial);
    if (key && !originalSerialByKey.has(key)) originalSerialByKey.set(key, serial);
  }

  return [...originalSerialByKey.entries()]
    .map(([key, serial]) => {
      const adb = adbBySerial.get(key) || null;
      const physical = physicalBySerial.get(key) || null;
      return {
        serial,
        key,
        adbState: String(adb?.state || "missing"),
        state: classifyDeviceRecoveryState({ adbState: adb?.state, physical, inventoryReady }),
        physicalPresent: Boolean(adb || (inventoryReady && physical)),
        inventoryPresent: Boolean(inventoryReady && physical),
        adb,
        physical
      };
    })
    .sort((left, right) => left.serial.localeCompare(right.serial));
}

export function isAutomaticPnpRecoveryState(state) {
  return [
    DEVICE_RECOVERY_STATES.USB_PRESENT_MTP_ONLY,
    DEVICE_RECOVERY_STATES.USB_COMPOSITE_NO_ADB_INTERFACE,
    DEVICE_RECOVERY_STATES.USB_ROOT_PNP_ERROR,
    DEVICE_RECOVERY_STATES.ADB_INTERFACE_PNP_ERROR,
    DEVICE_RECOVERY_STATES.ADB_INTERFACE_READY_TRANSPORT_MISSING
  ].includes(String(state || ""));
}

export function isAutomaticAdbTransportRecoveryState(state) {
  return String(state || "") === DEVICE_RECOVERY_STATES.ADB_OFFLINE;
}

export function exactPnpRestartTarget(observation = {}) {
  const physical = observation.physical || {};
  if ([
    DEVICE_RECOVERY_STATES.ADB_INTERFACE_PNP_ERROR,
    DEVICE_RECOVERY_STATES.ADB_INTERFACE_READY_TRANSPORT_MISSING
  ].includes(observation.state) && physical.adbInterfaceInstanceId) {
    return { instanceId: physical.adbInterfaceInstanceId, targetType: "adb_interface" };
  }
  if (physical.rootInstanceId) return { instanceId: physical.rootInstanceId, targetType: "usb_root" };
  return { instanceId: "", targetType: "none" };
}
