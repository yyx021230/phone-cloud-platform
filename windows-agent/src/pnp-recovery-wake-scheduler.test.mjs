import assert from "node:assert/strict";
import test from "node:test";

import { createPnpRecoveryWakeScheduler } from "./pnp-recovery-wake-scheduler.mjs";

function fakeTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    }
  };
}

test("coalesces recovery wakes without allowing a later request to postpone the earliest one", async () => {
  const timers = fakeTimers();
  const calls = [];
  const scheduler = createPnpRecoveryWakeScheduler({
    now: () => 1_000,
    timers,
    run: async (reason) => calls.push(reason)
  });
  scheduler.schedule(10_000, "slow");
  scheduler.schedule(20_000, "later");
  scheduler.schedule(5_000, "urgent");
  assert.equal(timers.pending.size, 1);
  const [{ callback, delay }] = timers.pending.values();
  assert.equal(delay, 5_000);
  await callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["urgent"]);
});

test("retries shortly when the guarded scan is still running", async () => {
  const timers = fakeTimers();
  const scheduler = createPnpRecoveryWakeScheduler({
    now: () => 2_000,
    timers,
    retryDelayMs: 750,
    run: async () => ({ skipped: true })
  });
  scheduler.schedule(5_000, "post_action");
  const first = [...timers.pending.values()][0];
  timers.pending.clear();
  await first.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].delay, 750);
});

test("cancel removes a pending recovery wake", () => {
  const timers = fakeTimers();
  const scheduler = createPnpRecoveryWakeScheduler({ timers });
  scheduler.schedule(5_000);
  scheduler.cancel();
  assert.equal(timers.pending.size, 0);
  assert.equal(scheduler.health().scheduled, false);
});
