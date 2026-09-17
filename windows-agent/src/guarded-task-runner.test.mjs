import assert from "node:assert/strict";
import test from "node:test";

import { createGuardedTaskRunner } from "./guarded-task-runner.mjs";

test("a timed-out task keeps its single-flight guard until the real work settles", async () => {
  let release;
  const errors = [];
  const runner = createGuardedTaskRunner({ onError: (error) => errors.push(error.message) });
  const first = await runner.run("scan", () => new Promise((resolve) => { release = resolve; }), 5);
  assert.equal(first.timedOut, true);
  assert.equal(runner.active("scan"), true);
  const second = await runner.run("scan", () => "should-not-run", 5);
  assert.deepEqual(second, { skipped: true, reason: "already_running" });
  release("done");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.active("scan"), false);
  assert.equal(errors.length, 1);
});
