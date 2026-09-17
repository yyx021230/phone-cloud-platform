export function indexCachedDevices(devices) {
  const indexed = new Map();
  for (const device of Array.isArray(devices) ? devices : []) {
    const deviceId = String(device?.deviceId || "").trim();
    if (deviceId) indexed.set(deviceId, device);
  }
  return indexed;
}

export function cachedAdbSerials(indexedDevices) {
  return [...indexedDevices.keys()]
    .filter((deviceId) => deviceId.startsWith("adb:"))
    .map((deviceId) => deviceId.slice(4))
    .filter(Boolean);
}

export function mergeCachedDeviceScanRow(row, previous = {}, serverDevice = {}) {
  const cached = {
    ...serverDevice,
    ...previous
  };
  return {
    ...cached,
    ...row,
    deviceId: row.deviceId || cached.deviceId || "",
    deviceName: row.deviceName || cached.deviceName || "",
    model: row.model || cached.model || "",
    manufacturer: row.manufacturer || cached.manufacturer || "",
    brand: row.brand || cached.brand || cached.manufacturer || "",
    androidVersion: row.androidVersion || cached.androidVersion || "",
    batteryLevel: row.batteryLevel ?? cached.batteryLevel ?? null,
    sims: Array.isArray(row.sims) && row.sims.length
      ? row.sims
      : Array.isArray(cached.sims) ? cached.sims : []
  };
}
