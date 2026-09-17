import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceActorManager } from "./device-actor.mjs";

test("serializes operations for one phone while different phones run concurrently", async () => {
  const manager = createDeviceActorManager();
  let activeA = 0;
  let maxA = 0;
  let activeAll = 0;
  let maxAll = 0;
  const run = (serial) => manager.get(serial).runBackgroundAdb(async () => {
    activeAll += 1;
    maxAll = Math.max(maxAll, activeAll);
    if (serial === "A") {
      activeA += 1;
      maxA = Math.max(maxA, activeA);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (serial === "A") activeA -= 1;
    activeAll -= 1;
  });

  await Promise.all([run("A"), run("A"), run("B")]);

  assert.equal(maxA, 1);
  assert.equal(maxAll, 2);
});

test("reports isolated per-device queue health without payload data", async () => {
  const manager = createDeviceActorManager();
  await manager.get("phone-1").runInteractiveAdb(async () => "ok", { label: "sms_refresh" });
  const health = manager.health();

  assert.equal(health[0].serial, "phone-1");
  assert.equal(health[0].lastOperation, "sms_refresh");
  assert.equal(health[0].queueDepth, 0);
  assert.equal(JSON.stringify(health).includes("ok"), false);
});
