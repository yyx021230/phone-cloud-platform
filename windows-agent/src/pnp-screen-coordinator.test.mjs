import assert from "node:assert/strict";
import test from "node:test";

import { createPnpScreenCoordinator } from "./pnp-screen-coordinator.mjs";

test("does not start PnP work while a screen lease exists", () => {
  const coordinator = createPnpScreenCoordinator();
  assert.equal(coordinator.tryBegin("phone-1", () => true), null);
  assert.equal(coordinator.active, false);
});

test("a screen start waits for PnP work on the same phone", async () => {
  let clock = 0;
  let release;
  const coordinator = createPnpScreenCoordinator({
    now: () => clock,
    async delayFn(ms) {
      clock += ms;
      if (clock >= 150 && release) release();
    }
  });
  release = coordinator.tryBegin("phone-1", () => false);
  assert.equal(coordinator.active, true);
  const result = await coordinator.waitForIdle("phone-1", 1_000, 50);
  assert.deepEqual(result, { idle: true, waitedMs: 150 });
  assert.equal(coordinator.active, false);
});

test("a screen start does not wait for PnP work on another phone", async () => {
  const coordinator = createPnpScreenCoordinator();
  const release = coordinator.tryBegin("phone-1");
  const result = await coordinator.waitForIdle("phone-2", 1_000, 50);
  assert.deepEqual(result, { idle: true, waitedMs: 0 });
  release();
});

test("global PnP work blocks every screen start", async () => {
  let clock = 0;
  let release;
  const coordinator = createPnpScreenCoordinator({
    now: () => clock,
    async delayFn(ms) {
      clock += ms;
      if (clock >= 100 && release) release();
    }
  });
  release = coordinator.tryBegin("*");
  const result = await coordinator.waitForIdle("phone-2", 1_000, 50);
  assert.deepEqual(result, { idle: true, waitedMs: 100 });
});

test("PnP work is released idempotently", () => {
  const coordinator = createPnpScreenCoordinator();
  const release = coordinator.tryBegin("phone-1", () => false);
  assert.equal(typeof release, "function");
  release();
  release();
  assert.equal(coordinator.active, false);
});
