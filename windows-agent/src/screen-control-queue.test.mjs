import assert from "node:assert/strict";
import test from "node:test";

import { createScreenControlQueue } from "./screen-control-queue.mjs";

test("executes control messages strictly in order", async () => {
  const events = [];
  let releaseDown;
  const downBlocked = new Promise((resolve) => { releaseDown = resolve; });
  const queue = createScreenControlQueue({
    async execute(message) {
      events.push(`start:${message.action}`);
      if (message.action === "down") await downBlocked;
      events.push(`end:${message.action}`);
    },
    acknowledge(message, result) { events.push(`ack:${message.action}:${result.status}`); }
  });

  queue.enqueue({ type: "touch", action: "down", sequenceId: 1 });
  queue.enqueue({ type: "touch", action: "up", sequenceId: 2 });
  await Promise.resolve();
  assert.deepEqual(events, ["start:down"]);

  releaseDown();
  await queue.drain();
  assert.deepEqual(events, [
    "start:down", "end:down", "ack:down:injected",
    "start:up", "end:up", "ack:up:injected"
  ]);
});

test("coalesces queued moves while preserving down and up", async () => {
  const executed = [];
  const acknowledgements = [];
  let releaseDown;
  const downBlocked = new Promise((resolve) => { releaseDown = resolve; });
  const queue = createScreenControlQueue({
    async execute(message) {
      executed.push(message.sequenceId);
      if (message.action === "down") await downBlocked;
    },
    acknowledge(message, result) { acknowledgements.push([message.sequenceId, result.status]); }
  });

  queue.enqueue({ type: "touch", action: "down", sequenceId: 1 });
  queue.enqueue({ type: "touch", action: "move", sequenceId: 2 });
  queue.enqueue({ type: "touch", action: "move", sequenceId: 3 });
  queue.enqueue({ type: "touch", action: "move", sequenceId: 4 });
  queue.enqueue({ type: "touch", action: "up", sequenceId: 5 });
  releaseDown();
  await queue.drain();

  assert.deepEqual(executed, [1, 4, 5]);
  assert.deepEqual(acknowledgements, [
    [2, "coalesced"],
    [3, "coalesced"],
    [1, "injected"],
    [4, "injected"],
    [5, "injected"]
  ]);
});

test("reports text actions without exposing their content", async () => {
  const acknowledgements = [];
  const queue = createScreenControlQueue({
    async execute() {},
    acknowledge(_message, result) { acknowledgements.push(result); }
  });

  queue.enqueue({ type: "text", text: "secret 验证码", sequenceId: 6 });
  await queue.drain();

  assert.equal(acknowledgements[0].action, "text");
  assert.doesNotMatch(JSON.stringify(acknowledgements[0]), /secret|验证码/);
});

test("times out a stuck controller write and releases the queue", async () => {
  const acknowledgements = [];
  const timedOut = [];
  const queue = createScreenControlQueue({
    async execute() {
      await new Promise(() => {});
    },
    acknowledge(message, result) {
      acknowledgements.push([message.sequenceId, result.status, result.error]);
    },
    onTimeout(message) {
      timedOut.push(message.sequenceId);
    },
    timeoutMs: 10
  });

  queue.enqueue({ type: "touch", action: "down", sequenceId: 7 });
  queue.enqueue({ type: "touch", action: "up", sequenceId: 8 });
  await queue.drain();

  assert.deepEqual(timedOut, [7]);
  assert.deepEqual(acknowledgements, [
    [7, "failed", "screen_control_timeout"],
    [8, "failed", "screen_control_timeout"]
  ]);
});

test("rejects new controls after the queue is closed", async () => {
  const executed = [];
  const acknowledgements = [];
  const queue = createScreenControlQueue({
    async execute(message) {
      executed.push(message.sequenceId);
    },
    acknowledge(message, result) {
      acknowledgements.push([message.sequenceId, result.status, result.error]);
    }
  });

  queue.close("screen_control_recovering");
  queue.enqueue({ type: "key", key: "home", sequenceId: 9 });
  await queue.drain();

  assert.deepEqual(executed, []);
  assert.deepEqual(acknowledgements, [[9, "failed", "screen_control_recovering"]]);
});
