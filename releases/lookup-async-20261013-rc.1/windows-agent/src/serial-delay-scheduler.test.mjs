import assert from "node:assert/strict";
import test from "node:test";
import { createSerialDelayScheduler } from "./serial-delay-scheduler.mjs";

test("delays a serial action and lets a new screen session cancel it", async () => {
  const actions = [];
  const scheduler = createSerialDelayScheduler({
    delayMs: 20,
    async action(serial) {
      actions.push(serial);
    }
  });

  scheduler.schedule("phone-1");
  assert.equal(scheduler.isPending("phone-1"), true);
  scheduler.cancel("phone-1");
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(actions, []);
  assert.equal(scheduler.isPending("phone-1"), false);
});

test("runs one delayed action per serial", async () => {
  const actions = [];
  const scheduler = createSerialDelayScheduler({
    delayMs: 10,
    async action(serial) {
      actions.push(serial);
    }
  });

  scheduler.schedule("phone-1");
  scheduler.schedule("phone-1");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(actions, ["phone-1"]);
  assert.equal(scheduler.isPending("phone-1"), false);
});
