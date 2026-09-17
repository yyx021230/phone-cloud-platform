import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeSaveScheduler } from "./runtime-save-scheduler.mjs";

test("defers runtime snapshot saves while realtime work is active", async () => {
  const timers = [];
  let busy = true;
  let saves = 0;
  const scheduler = createRuntimeSaveScheduler({
    save: async () => { saves += 1; },
    isBusy: () => busy,
    schedule(callback, delayMs) {
      timers.push({ callback, delayMs });
      return { unref() {} };
    },
    delayMs: 100,
    busyRetryMs: 500
  });

  scheduler.mark();
  const firstTimer = timers.shift();
  assert.equal(firstTimer.delayMs, 100);
  await firstTimer.callback();
  assert.equal(saves, 0);
  assert.equal(timers[0]?.delayMs, 500);

  busy = false;
  await scheduler.flush();
  assert.equal(saves, 1);
  assert.equal(scheduler.isDirty(), false);
});

test("coalesces repeated runtime changes into one snapshot save", async () => {
  const timers = [];
  let saves = 0;
  const scheduler = createRuntimeSaveScheduler({
    save: async () => { saves += 1; },
    isBusy: () => false,
    schedule(callback, delayMs) {
      timers.push({ callback, delayMs });
      return { unref() {} };
    },
    delayMs: 100
  });

  scheduler.mark();
  scheduler.mark();
  scheduler.mark();
  assert.equal(timers.length, 1);
  await timers[0].callback();
  assert.equal(saves, 1);
});
