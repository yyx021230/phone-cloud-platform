export function requireUserDeviceInventory(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.devices)) {
    const error = new Error("设备清单响应不完整，已保留上次有效数据。");
    error.code = "invalid_user_device_inventory";
    throw error;
  }
  return payload.devices;
}

export function createUserDeviceInventoryGuard({ emptyConfirmationCycles = 2 } = {}) {
  const confirmationCycles = Math.max(2, Number(emptyConfirmationCycles) || 2);
  let consecutiveEmptyCycles = 0;

  return {
    decide(previousDevices, nextDevices) {
      const previous = Array.isArray(previousDevices) ? previousDevices : [];
      const next = Array.isArray(nextDevices) ? nextDevices : [];

      if (next.length > 0 || previous.length === 0) {
        consecutiveEmptyCycles = 0;
        return { apply: true, devices: next, reason: next.length ? "non_empty" : "initial_empty" };
      }

      consecutiveEmptyCycles += 1;
      if (consecutiveEmptyCycles < confirmationCycles) {
        return {
          apply: false,
          devices: previous,
          reason: "unconfirmed_empty",
          confirmationCycle: consecutiveEmptyCycles
        };
      }

      consecutiveEmptyCycles = 0;
      return { apply: true, devices: next, reason: "confirmed_empty" };
    },

    reset() {
      consecutiveEmptyCycles = 0;
    }
  };
}
