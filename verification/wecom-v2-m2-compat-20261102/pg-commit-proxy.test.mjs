// Pure bytes only. No listening server, real connection or PG process.
import assert from "node:assert/strict";
import test from "node:test";
import { FrameReader, CommitGate } from "./pg-commit-proxy.mjs";
function frame(type, text) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text), raw = Buffer.alloc(5 + payload.length);
  raw[0] = type.charCodeAt(0); raw.writeUInt32BE(4 + payload.length, 1); payload.copy(raw, 5);
  return new FrameReader().feed(raw)[0];
}
test("fragmented frames preserve bytes; oversized/SSL startup is rejected", () => {
  const f = frame("C", "COMMIT\0"), reader = new FrameReader();
  assert.deepEqual(reader.feed(f.raw.subarray(0, 3)), []);
  assert.deepEqual(reader.feed(f.raw.subarray(3))[0].raw, f.raw);
  assert.throws(() => new FrameReader().feed(Buffer.from([67, 0, 2, 0, 0])), /frame_bound/);
  const ssl = Buffer.alloc(8); ssl.writeUInt32BE(8); ssl.writeUInt32BE(80877103, 4);
  assert.throws(() => new FrameReader(true).feed(ssl), /startup_protocol/);
});
test("only one exact COMMIT/I/no-ErrorResponse tuple confirms backend completion", () => {
  const events = [], gate = new CommitGate("after_commit", { spent: false }, e => events.push(e));
  assert.equal(gate.frontend(frame("Q", "COMMIT\0")).forward, true);
  assert.deepEqual(gate.backend(frame("C", "COMMIT\0")), { forward: false, drop: false });
  assert.deepEqual(gate.backend(frame("Z", "I")), { forward: false, drop: true });
  assert.equal(events.at(-1).commitConfirmedFromBackend, true);
});
for (const [label, frames] of [
  ["ROLLBACK tag", [frame("C", "ROLLBACK\0"), frame("Z", "I")]],
  ["error present", [frame("E", "fixture-error\0"), frame("C", "COMMIT\0"), frame("Z", "I")]],
  ["transaction still open", [frame("C", "COMMIT\0"), frame("Z", "T")]],
  ["no command completion", [frame("Z", "I")]],
  ["two command completions", [frame("C", "COMMIT\0"), frame("C", "COMMIT\0"), frame("Z", "I")]],
]) test(`gate refuses success when ${label}`, () => {
  const events = [], gate = new CommitGate("after_commit", { spent: false }, e => events.push(e));
  gate.frontend(frame("Q", "COMMIT\0")); for (const f of frames) gate.backend(f);
  assert.equal(events.at(-1).commitConfirmedFromBackend, false);
});
test("before-COMMIT drop sends no COMMIT; consumed fault is not applied again", () => {
  const events = [], shared = { spent: false }, a = new CommitGate("before_commit", shared, e => events.push(e));
  assert.deepEqual(a.frontend(frame("Q", "COMMIT\0")), { forward: false, drop: true });
  const b = new CommitGate("before_commit", shared, () => {});
  assert.deepEqual(b.frontend(frame("Q", "COMMIT\0")), { forward: true, drop: false });
  assert.ok(!events.some(e => e.commitConfirmedFromBackend));
});
