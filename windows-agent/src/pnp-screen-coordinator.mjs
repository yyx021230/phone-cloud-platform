export function createPnpScreenCoordinator(options = {}) {
  const now = options.now || Date.now;
  const delayFn = options.delayFn || delay;
  let activeSerial = "";

  function tryBegin(serial = "*", isSerialBusy = () => false) {
    const normalizedSerial = String(serial || "*");
    if (activeSerial || isSerialBusy(normalizedSerial)) return null;
    activeSerial = normalizedSerial;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSerial = "";
    };
  }

  async function waitForIdle(serial = "*", timeoutMs = 30_000, pollMs = 50) {
    const normalizedSerial = String(serial || "*");
    const startedAt = now();
    const deadline = startedAt + Math.max(0, Number(timeoutMs || 0));
    while (activeSerial && (activeSerial === "*" || normalizedSerial === "*" || activeSerial === normalizedSerial)) {
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
    get active() { return Boolean(activeSerial); },
    get activeSerial() { return activeSerial; }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
