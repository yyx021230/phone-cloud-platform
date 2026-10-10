export function createSerialAdbActivityTracker() {
  const activeBySerial = new Map();
  const idleWaitersBySerial = new Map();

  function begin(serial) {
    const key = String(serial || "").trim();
    if (!key) return () => {};
    activeBySerial.set(key, Number(activeBySerial.get(key) || 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = Math.max(0, Number(activeBySerial.get(key) || 0) - 1);
      if (remaining) {
        activeBySerial.set(key, remaining);
        return;
      }
      activeBySerial.delete(key);
      const waiters = idleWaitersBySerial.get(key) || [];
      idleWaitersBySerial.delete(key);
      for (const resolve of waiters) resolve(true);
    };
  }

  async function waitForIdle(serial, timeoutMs = 15_000) {
    const key = String(serial || "").trim();
    if (!key || !activeBySerial.get(key)) return true;
    let timer;
    return await new Promise((resolve) => {
      const waiters = idleWaitersBySerial.get(key) || [];
      const finish = (idle) => {
        clearTimeout(timer);
        const current = idleWaitersBySerial.get(key) || [];
        const remaining = current.filter((item) => item !== finish);
        if (remaining.length) idleWaitersBySerial.set(key, remaining);
        else idleWaitersBySerial.delete(key);
        resolve(idle);
      };
      waiters.push(finish);
      idleWaitersBySerial.set(key, waiters);
      timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs || 0)));
    });
  }

  return {
    begin,
    waitForIdle,
    activeCount(serial) {
      return Number(activeBySerial.get(String(serial || "").trim()) || 0);
    }
  };
}
