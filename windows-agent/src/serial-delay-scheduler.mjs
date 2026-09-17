export function createSerialDelayScheduler(options) {
  const timers = new Map();
  const delayMs = Math.max(0, Number(options.delayMs || 0));

  function cancel(serial) {
    const key = String(serial || "").trim();
    const timer = timers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    timers.delete(key);
    return true;
  }

  function schedule(serial) {
    const key = String(serial || "").trim();
    if (!key) return;
    cancel(key);
    const timer = setTimeout(async () => {
      timers.delete(key);
      try {
        await options.action(key);
      } catch (error) {
        options.onError?.(error, key);
      }
    }, delayMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  return {
    schedule,
    cancel,
    isPending(serial) {
      return timers.has(String(serial || "").trim());
    }
  };
}
