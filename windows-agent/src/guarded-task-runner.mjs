export function createGuardedTaskRunner(options = {}) {
  const onError = options.onError || (() => {});
  const timers = options.timers || { setTimeout, clearTimeout };
  const active = new Map();

  async function run(name, fn, timeoutMs) {
    if (active.has(name)) return { skipped: true, reason: "already_running" };
    const entry = { settled: false, task: null };
    const task = Promise.resolve().then(fn);
    entry.task = task;
    active.set(name, entry);
    task.finally(() => {
      entry.settled = true;
      if (active.get(name) === entry) active.delete(name);
    }).catch(() => {});

    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), Math.max(1, Number(timeoutMs || 1)));
    });
    try {
      const value = await Promise.race([task, timeout]);
      return { skipped: false, timedOut: false, value };
    } catch (error) {
      onError(error, name);
      return { skipped: false, timedOut: !entry.settled, error };
    } finally {
      if (timer) timers.clearTimeout(timer);
      // A timed-out task remains the owner of this name until its real promise
      // settles. This prevents a second scan from stacking more PnP work on a
      // still-running Windows DeviceInstall operation.
      if (entry.settled && active.get(name) === entry) active.delete(name);
    }
  }

  return {
    run,
    active(name) { return active.has(name); }
  };
}
