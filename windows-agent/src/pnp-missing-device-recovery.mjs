export function createPnpMissingDeviceRecovery(options = {}) {
  const now = options.now || Date.now;
  const rescanAfterMissingScans = Math.max(1, Number(options.rescanAfterMissingScans || 2));
  const resetAfterMissingScans = Math.max(rescanAfterMissingScans, Number(options.resetAfterMissingScans || 3));
  const rescanCooldownMs = Math.max(1, Number(options.rescanCooldownMs || 180_000));
  const resetCooldownMs = Math.max(1, Number(options.resetCooldownMs || 90_000));
  const trackingWindowMs = Math.max(1, Number(options.trackingWindowMs || 86_400_000));
  const absentRetryMs = Math.max(resetCooldownMs, Number(options.absentRetryMs || 1_800_000));
  const tracked = new Map();
  let lastRescanAt = 0;

  function normalizeSerial(value) {
    return String(value || "").trim();
  }

  function serialKey(value) {
    return normalizeSerial(value).toUpperCase();
  }

  function markRescan() {
    lastRescanAt = now();
  }

  function markReset(serial, { targetPresent = true, retryAfterMs = resetCooldownMs } = {}) {
    const state = tracked.get(serialKey(serial));
    if (state) {
      const at = now();
      state.lastResetAt = at;
      // A phone can expose itself to Windows a while after it first disappears
      // from ADB.  Do not forget it after the normal scan window, but also do
      // not repeatedly reset a port which is not physically present.
      const targetRetryMs = Math.max(resetCooldownMs, Number(retryAfterMs || resetCooldownMs));
      state.nextResetAt = at + (targetPresent ? targetRetryMs : absentRetryMs);
    }
  }

  function seed(serials = []) {
    const at = now();
    for (const value of serials) {
      const serial = normalizeSerial(value);
      const key = serialKey(serial);
      if (!serial || tracked.has(key)) continue;
      tracked.set(key, {
        serial,
        lastSeenAt: at,
        missingScans: 0,
        lastResetAt: -Infinity,
        nextResetAt: -Infinity
      });
    }
  }

  function observe({ devices = [], busy = false, isSerialBusy = () => false } = {}) {
    const at = now();
    const online = new Set();
    for (const device of devices) {
      if (device?.state !== "device") continue;
      const serial = normalizeSerial(device.adbSerial);
      if (!serial) continue;
      const key = serialKey(serial);
      online.add(key);
      // Use -Infinity rather than 0 so an injected test clock beginning at zero
      // has the same "never reset" semantics as production.
      tracked.set(key, { serial, lastSeenAt: at, missingScans: 0, lastResetAt: -Infinity, nextResetAt: -Infinity });
    }

    const missing = [];
    for (const [key, state] of tracked) {
      if (online.has(key)) continue;
      if (at - state.lastSeenAt > trackingWindowMs) {
        tracked.delete(key);
        continue;
      }
      state.missingScans += 1;
      missing.push({
        serial: state.serial,
        missingScans: state.missingScans,
        lastResetAt: state.lastResetAt,
        nextResetAt: state.nextResetAt
      });
    }

    const rescanSerials = !busy && at - lastRescanAt >= rescanCooldownMs
      ? missing.filter((item) => item.missingScans >= rescanAfterMissingScans).map((item) => item.serial)
      : [];
    const resetSerials = !busy
      ? missing
        .filter((item) => item.missingScans >= resetAfterMissingScans)
        .filter((item) => at >= (item.nextResetAt ?? -Infinity))
        .filter((item) => !isSerialBusy(item.serial))
        .map((item) => item.serial)
      : [];

    return {
      missing,
      rescanSerials,
      resetSerials,
      deferredBusy: Boolean(busy && missing.length)
    };
  }

  return { observe, markRescan, markReset, seed };
}
