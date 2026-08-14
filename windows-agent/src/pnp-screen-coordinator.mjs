export function createPnpScreenCoordinator(options = {}) {
  const now = options.now || Date.now;
  const delayFn = options.delayFn || delay;
  const maxConcurrent = Math.max(1, Math.min(16, Number(options.maxConcurrent || 1)));
  const activeSerials = new Set();

  function normalizeSerial(value) {
    return String(value || "*").trim().toUpperCase() || "*";
  }

  function tryBegin(serial = "*", isSerialBusy = () => false) {
    const normalizedSerial = normalizeSerial(serial);
    if (isSerialBusy(normalizedSerial)) return null;
    if (normalizedSerial === "*") {
      if (activeSerials.size) return null;
    } else if (activeSerials.has("*") || activeSerials.has(normalizedSerial) || activeSerials.size >= maxConcurrent) {
      return null;
    }
    activeSerials.add(normalizedSerial);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSerials.delete(normalizedSerial);
    };
  }

  async function waitForIdle(serial = "*", timeoutMs = 30_000, pollMs = 50) {
    const normalizedSerial = normalizeSerial(serial);
    const startedAt = now();
    const deadline = startedAt + Math.max(0, Number(timeoutMs || 0));
    const blocked = () => activeSerials.has("*") || (normalizedSerial === "*" ? activeSerials.size > 0 : activeSerials.has(normalizedSerial));
    while (blocked()) {
      if (now() >= deadline) {
        return { idle: false, waitedMs: Math.max(0, now() - startedAt) };
      }
      await delayFn(Math.max(10, Number(pollMs || 50)));
    }
    return { idle: true, waitedMs: Math.max(0, now() - startedAt) };
  }

  return {
    tryBegin,
    waitForIdle,
    get active() { return activeSerials.size > 0; },
    get activeSerial() { return activeSerials.values().next().value || ""; },
    get activeSerials() { return [...activeSerials]; }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
