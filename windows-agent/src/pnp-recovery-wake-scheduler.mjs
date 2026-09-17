export function createPnpRecoveryWakeScheduler(options = {}) {
  const run = options.run || (async () => ({}));
  const now = options.now || Date.now;
  const timers = options.timers || { setTimeout, clearTimeout };
  const retryDelayMs = Math.max(1, Number(options.retryDelayMs || 1_000));
  const onError = options.onError || (() => {});
  let timer = null;
  let dueAt = 0;
  let reason = "";
  let running = false;

  function schedule(delayMs, nextReason = "pnp_recovery_followup") {
    const delay = Math.max(1, Number(delayMs || 1));
    const nextDueAt = now() + delay;
    // Coalesce many devices/actions into the earliest host-wide wake. A later
    // request never postpones work which is already scheduled sooner.
    if (timer && dueAt <= nextDueAt) return { scheduled: false, dueAt, reason };
    if (timer) timers.clearTimeout(timer);
    dueAt = nextDueAt;
    reason = String(nextReason || "pnp_recovery_followup");
    timer = timers.setTimeout(() => {
      timer = null;
      dueAt = 0;
      const wakeReason = reason;
      reason = "";
      void fire(wakeReason);
    }, delay);
    return { scheduled: true, dueAt, reason };
  }

  async function fire(wakeReason) {
    if (running) {
      schedule(retryDelayMs, wakeReason);
      return;
    }
    running = true;
    try {
      const result = await run(wakeReason);
      if (result?.skipped) schedule(retryDelayMs, wakeReason);
    } catch (error) {
      onError(error, wakeReason);
    } finally {
      running = false;
    }
  }

  function cancel() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    dueAt = 0;
    reason = "";
  }

  function health() {
    return { scheduled: Boolean(timer), dueAt, reason, running };
  }

  return { schedule, cancel, health };
}
