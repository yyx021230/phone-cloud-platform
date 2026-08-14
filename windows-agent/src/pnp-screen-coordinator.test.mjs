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

test("targeted PnP work does not block a screen start on another phone", async () => {
  const coordinator = createPnpScreenCoordinator({ maxConcurrent: 8 });
  const release = coordinator.tryBegin("phone-1");
  const result = await coordinator.waitForIdle("phone-2", 1_000, 50);
  assert.deepEqual(result, { idle: true, waitedMs: 0 });
  release();
});

test("serializes targeted PnP work even across different phones", () => {
  const coordinator = createPnpScreenCoordinator();
  const releasePhone1 = coordinator.tryBegin("phone-1");
  const releasePhone2 = coordinator.tryBegin("phone-2");
  assert.equal(typeof releasePhone1, "function");
  assert.equal(releasePhone2, null);
  assert.deepEqual(coordinator.activeSerials, ["PHONE-1"]);
  assert.equal(coordinator.tryBegin("phone-1"), null);
  assert.equal(coordinator.tryBegin("*"), null);
  releasePhone1();
  assert.equal(coordinator.active, false);
});

test("allows eight exact phone recoveries and rejects a ninth lane", () => {
  const coordinator = createPnpScreenCoordinator({ maxConcurrent: 8 });
  const releases = Array.from({ length: 8 }, (_, index) => coordinator.tryBegin(`phone-${index + 1}`));
  assert.ok(releases.every((release) => typeof release === "function"));
  assert.equal(coordinator.tryBegin("phone-9"), null);
  assert.equal(coordinator.activeSerials.length, 8);
  releases.forEach((release) => release());
  assert.equal(coordinator.active, false);
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
