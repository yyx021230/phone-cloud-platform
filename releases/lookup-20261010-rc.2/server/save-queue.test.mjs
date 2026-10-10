import assert from "node:assert/strict";
import test from "node:test";

import { createSaveQueue } from "./save-queue.mjs";

test("a failed save does not poison later saves", async () => {
  const queue = createSaveQueue();
  const calls = [];
  await assert.rejects(queue.enqueue(async () => {
    calls.push("failed");
    throw new Error("bad snapshot");
  }), /bad snapshot/);
  const result = await queue.enqueue(async () => {
    calls.push("recovered");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["failed", "recovered"]);
});

test("saves remain serialized", async () => {
  const queue = createSaveQueue();
  const calls = [];
  let releaseFirst;
  const first = queue.enqueue(async () => {
    calls.push("first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    calls.push("first:end");
  });
  const second = queue.enqueue(async () => { calls.push("second"); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["first:start", "first:end", "second"]);
});
