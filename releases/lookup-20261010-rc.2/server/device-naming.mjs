export function defaultAdbDeviceName(adbDevice = {}) {
  const brand = String(adbDevice.brand || adbDevice.manufacturer || adbDevice.model || "").trim();
  const serial = String(adbDevice.adbSerial || adbDevice.serial || "").trim();
  return [brand, serial].filter(Boolean).join("-") || serial || brand || "";
}

export function isAutoAdbDeviceName(deviceName = "", adbDevice = {}) {
  const current = String(deviceName || "").trim();
  if (!current) return true;
  const serial = String(adbDevice.adbSerial || adbDevice.serial || "").trim();
  const model = String(adbDevice.model || "").trim();
  const brand = String(adbDevice.brand || adbDevice.manufacturer || "").trim();
  const autoNames = new Set([
    serial,
    model,
    brand,
    [model, serial].filter(Boolean).join("-"),
    [brand, serial].filter(Boolean).join("-")
  ].filter(Boolean));
  return autoNames.has(current);
}

export function applyAdminDeviceName(device, deviceName, updatedAt = new Date().toISOString()) {
  device.deviceName = String(deviceName || "").trim();
  device.deviceNameSource = "admin";
  device.deviceNameUpdatedAt = updatedAt;
  return device.deviceName;
}

export function applyAdbDeviceName(device, adbDevice = {}, updatedAt = new Date().toISOString()) {
  if (device.deviceNameSource === "admin") return device.deviceName;

  if (!device.deviceNameSource && device.deviceName && !isAutoAdbDeviceName(device.deviceName, adbDevice)) {
    device.deviceNameSource = "admin";
    device.deviceNameUpdatedAt ||= device.updatedAt || device.createdAt || updatedAt;
    return device.deviceName;
  }

  device.deviceName = defaultAdbDeviceName(adbDevice);
  device.deviceNameSource = "auto";
  device.deviceNameUpdatedAt = updatedAt;
  return device.deviceName;
}

export function applyPhoneAgentDeviceName(device, reportedName, updatedAt = new Date().toISOString()) {
  const adbDevice = {
    adbSerial: device.adb?.serial || "",
    serial: device.adb?.serial || "",
    model: device.adb?.model || device.model || "",
    manufacturer: device.adb?.manufacturer || device.manufacturer || "",
    brand: device.adb?.brand || device.brand || "",
    deviceName: reportedName
  };
  if (device.deviceNameSource === "admin") return device.deviceName;

  if (!device.deviceNameSource && device.deviceName && !isAutoAdbDeviceName(device.deviceName, adbDevice)) {
    device.deviceNameSource = "admin";
    device.deviceNameUpdatedAt ||= device.updatedAt || device.createdAt || updatedAt;
    return device.deviceName;
  }

  const nextName = String(reportedName || "").trim();
  if (nextName) {
    device.deviceName = nextName;
    device.deviceNameSource = "phone_agent";
    device.deviceNameUpdatedAt = updatedAt;
  } else if (!device.deviceName) {
    device.deviceName = device.deviceId || "";
    device.deviceNameSource = "auto";
    device.deviceNameUpdatedAt = updatedAt;
  }
  return device.deviceName;
}
