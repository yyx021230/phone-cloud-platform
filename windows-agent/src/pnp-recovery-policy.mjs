export const ANDROID_USB_VENDOR_IDS = Object.freeze([
  "2D95", // vivo
  "2717", // Xiaomi
  "22D9", // OPPO/OnePlus
  "12D1", // Huawei
  "339B", // Honor
  "18D1", // Android/Google composite gadget
  "1782"  // Unisoc/Spreadtrum Android gadget
]);

export function pnpTargetRecoveryMode(attempt) {
  return Number(attempt) <= 1 ? "restart" : "reenumerate";
}

export function pnpTargetRecoveryBackoffMs(attempt, baseMs, capMs) {
  const normalizedBase = Math.max(1, Number(baseMs || 1));
  const normalizedCap = Math.max(normalizedBase, Number(capMs || normalizedBase));
  const exponent = Math.max(0, Math.min(8, Number(attempt || 1) - 1));
  return Math.min(normalizedCap, normalizedBase * (2 ** exponent));
}

export function orderPnpRecoveryTargets(serials, attemptsBySerial) {
  return [...serials].sort((left, right) => {
    const leftState = attemptsBySerial.get(String(left).toUpperCase()) || {};
    const rightState = attemptsBySerial.get(String(right).toUpperCase()) || {};
    const attemptDelta = Number(leftState.attempts || 0) - Number(rightState.attempts || 0);
    if (attemptDelta) return attemptDelta;
    const timeDelta = Number(leftState.lastAttemptAt || 0) - Number(rightState.lastAttemptAt || 0);
    if (timeDelta) return timeDelta;
    return String(left).localeCompare(String(right));
  });
}
