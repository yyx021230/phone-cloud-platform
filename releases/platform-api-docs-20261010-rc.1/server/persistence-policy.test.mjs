import assert from "node:assert/strict";
import test from "node:test";

import { createPersistencePolicy } from "./persistence-policy.mjs";

test("uses a structured write and schedules only a compatibility checkpoint", async () => {
  const calls = [];
  const policy = createPersistencePolicy({
    structuredWritesEnabled: true,
    saveSnapshot: async () => calls.push("snapshot"),
    scheduleCheckpoint: () => calls.push("checkpoint")
  });

  await policy.persist(async () => calls.push("structured"));

  assert.deepEqual(calls, ["structured", "checkpoint"]);
});

test("falls back to a durable snapshot when structured writes are disabled", async () => {
  const calls = [];
  const policy = createPersistencePolicy({
    structuredWritesEnabled: false,
    saveSnapshot: async () => calls.push("snapshot"),
    scheduleCheckpoint: () => calls.push("checkpoint")
  });

  await policy.persist(async () => calls.push("structured"));

  assert.deepEqual(calls, ["snapshot"]);
});

test("does not schedule a checkpoint when the structured write fails", async () => {
  const calls = [];
  const policy = createPersistencePolicy({
    structuredWritesEnabled: true,
    saveSnapshot: async () => calls.push("snapshot"),
    scheduleCheckpoint: () => calls.push("checkpoint")
  });

  await assert.rejects(policy.persist(async () => {
    calls.push("structured");
    throw new Error("write_failed");
  }), /write_failed/);

  assert.deepEqual(calls, ["structured"]);
});
