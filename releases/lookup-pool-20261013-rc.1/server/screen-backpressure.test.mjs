import assert from "node:assert/strict";
import test from "node:test";

import { createVideoBackpressureGate as createServerGate } from "./screen-backpressure.mjs";
import { createVideoBackpressureGate as createAgentGate } from "../windows-agent/src/screen-backpressure.mjs";

const configuration = Buffer.from([0, 0, 1]);
const deltaFrame = Buffer.from([1, 0, 2]);
const keyframe = Buffer.from([1, 1, 3]);

for (const [name, createGate] of [["server", createServerGate], ["agent", createAgentGate]]) {
  test(`${name} drops stale delta frames and recovers on a keyframe`, () => {
    const gate = createGate({ highWaterMark: 100, lowWaterMark: 20 });
    assert.equal(gate.inspect(deltaFrame, 0).forward, true);
    assert.deepEqual(gate.inspect(deltaFrame, 101), { forward: false, dropped: true, recovered: false });
    assert.equal(gate.inspect(deltaFrame, 10).forward, false);
    assert.equal(gate.inspect(keyframe, 50).forward, false);
    assert.deepEqual(gate.inspect(keyframe, 10), { forward: true, dropped: false, recovered: true });
    assert.equal(gate.inspect(deltaFrame, 10).forward, true);
  });

  test(`${name} always forwards codec configuration`, () => {
    const gate = createGate({ highWaterMark: 100, lowWaterMark: 20 });
    gate.inspect(deltaFrame, 101);
    assert.deepEqual(gate.inspect(configuration, 500), { forward: true, dropped: false, recovered: false });
  });
}
