// Actual EventEmitter only; no PG/network, and no global exception handler.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createFaultClientObserver } from "./pg-fault-observer.mjs";
const fault = () => new Error("Connection terminated unexpectedly");
const completed = () => ({ mode: "after_commit", faultSpent: true, events: [{ connectionId: 1, event: "backend_commit_completion",
  commitConfirmedFromBackend: true, commandTag: "COMMIT", commandCompleteCount: 1, readyForQuery: "I", errorResponseCount: 0 }] });
function setup(readWire = completed) {
  const observer = createFaultClientObserver({ readWire, mode: "after_commit" }), client = new EventEmitter(); client.processID = 42;
  observer.attach(client); return { observer, client };
}
test("observes only matching fault with an additional owned transaction listener", () => {
  const { observer, client } = setup(), owned = () => {}; client.on("error", owned);
  assert.doesNotThrow(() => client.emit("error", fault()));
  assert.equal(observer.snapshot()[0].expected, true); assert.equal(observer.snapshot()[0].otherErrorListeners, 1);
  client.emit("end"); assert.deepEqual(client.listeners("error"), [owned]);
});
test("fixture observer alone cannot make missing M2 owned listener green", () => {
  const { observer, client } = setup(); assert.throws(() => client.emit("error", fault()), /unexpected_client_error/);
  assert.equal(observer.snapshot()[0].expected, false);
});
test("other client error must fail even when original wire fault exists", () => {
  const { observer } = setup(), other = new EventEmitter(); other.processID = 43; observer.attach(other); other.on("error", () => {});
  assert.throws(() => other.emit("error", fault()), /unexpected_client_error/);
  assert.equal(observer.snapshot()[0].originalFaultClient, false);
});
test("different error and absent wire proof both fail", () => {
  const a = setup(); a.client.on("error", () => {});
  assert.throws(() => a.client.emit("error", new Error("fixture_other_error")), /unexpected_client_error/);
  const b = setup(() => ({ mode: "after_commit", faultSpent: false, events: [] })); b.client.on("error", () => {});
  assert.throws(() => b.client.emit("error", fault()), /unexpected_client_error/);
});
test("bad COMMIT tuples cannot justify a client error", () => {
  for (const patch of [{ commandTag: "ROLLBACK" }, { readyForQuery: "T" }, { errorResponseCount: 1 }]) {
    const f = setup(() => { const w = completed(); Object.assign(w.events[0], patch); return w; }); f.client.on("error", () => {});
    assert.throws(() => f.client.emit("error", fault()), /unexpected_client_error/);
  }
});
test("idle pool events always fail and duplicate attachment is refused", () => {
  const { observer, client } = setup(); assert.throws(() => observer.poolError(fault(), client), /unexpected_idle_pool_error/);
  assert.throws(() => observer.attach(client), /observer_duplicate/);
});
test("expected observation count is bounded", () => {
  const { observer, client } = setup(); client.on("error", () => {});
  for (let i = 0; i < 8; i++) client.emit("error", fault());
  assert.throws(() => client.emit("error", fault()), /observation_bound/); assert.equal(observer.snapshot().length, 8);
});
