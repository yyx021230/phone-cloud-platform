import assert from "node:assert/strict";
import test from "node:test";

import { createAdbPriorityQueue } from "./adb-priority-queue.mjs";

test("serializes work and runs the highest queued priority next", async () => {
  const queue = createAdbPriorityQueue();
  const order = [];
  let release;
  const first = queue.enqueue(async () => {
    order.push("active");
    await new Promise((resolve) => { release = resolve; });
  }, { priority: 1, label: "active" });
  await Promise.resolve();
  const low = queue.enqueue(async () => { order.push("low"); }, { priority: 10, label: "low" });
  const high = queue.enqueue(async () => { order.push("high"); }, { priority: 100, label: "high" });
  release();
  await Promise.all([first, low, high]);

  assert.deepEqual(order, ["active", "high", "low"]);
  assert.equal(queue.health().queueDepth, 0);
});

test("removes an aborted operation before it starts", async () => {
  const queue = createAdbPriorityQueue();
  let release;
  const first = queue.enqueue(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  const cancelled = queue.enqueue(async () => "never", { signal: controller.signal });
  const cancellation = assert.rejects(cancelled, (error) => error.name === "AbortError");
  controller.abort();
  release();
  await first;
  await cancellation;
});
