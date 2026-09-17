import assert from "node:assert/strict";
import test from "node:test";

import { createSingleFlightRunner } from "./single-flight.mjs";

test("shares one active run and starts a new run only after it settles", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = createSingleFlightRunner(async () => {
    calls += 1;
    await gate;
    return calls;
  });

  const first = run();
  const overlapping = run();
  assert.strictEqual(first, overlapping);
  assert.equal(calls, 0);

  release();
  assert.equal(await first, 1);
  assert.equal(await run(), 2);
  assert.equal(calls, 2);
});
