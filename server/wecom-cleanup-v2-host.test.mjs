import assert from "node:assert/strict";
import test from "node:test";
import { createWecomV2HostState, createWecomV2HostPreparer } from "./wecom-cleanup-v2-host.mjs";

function auditBirth(milliseconds) {
  const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, milliseconds / 1000);
  const bits = bytes.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n) - 1023;
  const fraction = (bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0");
  return { createdAt: new Date(milliseconds).toISOString(), creationToken: `0x1.${fraction}p${exponent >= 0 ? "+" : ""}${exponent}` };
}
function fixture({ wall = "2026-11-02T00:00:00.000Z", slot = "main" } = {}) {
  const binding = { version: 2, obligationId: "duty", originalTaskId: "task", executionId: "execution", deviceId: "adb:fixture",
    serial: "fixture", agentId: "agent", appSlot: slot, androidUser: slot === "main" ? 0 : 999,
    nonce: "binding-nonce", serverEpoch: "server-epoch", agentInstanceId: "agent-instance", handshakeNonce: "spawn-nonce" };
  const parentHost = { role: "agent", pid: 100, ...auditBirth(Date.parse(wall)), machineId: "a".repeat(64) };
  const readerHost = { ...parentHost, role: "reader", pid: 101, ...auditBirth(Date.parse(wall) + 1) };
  const facts = { agentInstanceId: binding.agentInstanceId, parentHost, readerHost, spawnNonce: binding.handshakeNonce, closeEventId: null };
  const auth = structuredClone(binding);
  const prepare = createWecomV2HostPreparer({ readAuthenticatedBinding: () => auth, readParentInstanceFacts: () => facts });
  const first = createWecomV2HostState(binding);
  const body = { binding: structuredClone(binding), operationId: "host-operation", expectedRevision: 0,
    parentHost: structuredClone(parentHost), readerHost: structuredClone(readerHost), readyNonce: binding.handshakeNonce };
  const register = () => prepare(first, "host", body);
  function closeBody() {
    return { ...structuredClone(body), operationId: "close-operation", expectedRevision: 1, closeEventId: "native-close-event" };
  }
  return { binding, facts, auth, prepare, first, body, register, closeBody };
}

test("two stages prepare immutable held states; neither is durable ACK or release", () => {
  const f = fixture(), before = JSON.stringify([f.first, f.body, f.facts, f.auth]);
  const one = f.register();
  assert.equal(one.nextState.revision, 1); assert.equal(one.nextState.phase, "awaiting_host_close");
  assert.equal(one.nextState.fence, "held"); assert.equal(one.replyCandidate.durable, false);
  assert.equal(one.replyCandidate.requiresPersistence, true); assert.equal(one.reused, false);
  assert.equal(JSON.stringify([f.first, f.body, f.facts, f.auth]), before);
  f.facts.closeEventId = "native-close-event";
  const two = f.prepare(one.nextState, "host-closed", f.closeBody());
  assert.equal(two.nextState.revision, 2); assert.equal(two.nextState.phase, "awaiting_verification");
  assert.equal(two.nextState.fence, "held"); assert.equal(two.replyCandidate.durable, false);
  for (const value of [one, one.nextState, one.nextState.operations, one.nextState.readerHost, two.replyCandidate]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { one.nextState.readerHost.pid = 500; }, TypeError);
  assert.equal(f.first.revision, 0); assert.equal(f.body.readerHost.pid, 101);
});
test("deeply frozen caller inputs and provider facts are never modified", () => {
  const f = fixture();
  function freeze(value) {
    if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
  }
  for (const value of [f.body, f.facts, f.auth]) freeze(value);
  const one = f.register();
  assert.equal(one.nextState.revision, 1); assert.equal(f.body.expectedRevision, 0);
  assert.notEqual(one.nextState.binding, f.auth); assert.notEqual(one.nextState.readerHost, f.body.readerHost);
});

for (const wall of ["2000-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
  test(`audit wall ${wall} is not compared to cloud now`, () => {
    const f = fixture({ wall });
    const one = f.register(); f.facts.closeEventId = "native-close-event";
    const two = f.prepare(one.nextState, "host-closed", f.closeBody());
    assert.equal(two.nextState.parentHost.createdAt, wall);
    assert.equal(two.nextState.readerHost.createdAt, new Date(Date.parse(wall) + 1).toISOString()); assert.equal(two.nextState.fence, "held");
  });
}
test("configured clone binds Android user999, never changes main identity", () => {
  const f = fixture({ slot: "clone" }); assert.equal(f.register().nextState.binding.androidUser, 999);
  f.body.binding.androidUser = 0; assert.throws(f.register, /binding_invalid/);
});
test("object key order normalizes; identical operation returns original candidate without increment", () => {
  const f = fixture(), one = f.register();
  const reverse = value => Object.fromEntries(Object.entries(value).reverse());
  const reordered = reverse({ ...f.body, binding: reverse(f.body.binding), parentHost: reverse(f.body.parentHost), readerHost: reverse(f.body.readerHost) });
  const reused = f.prepare(one.nextState, "host", reordered);
  assert.equal(reused.reused, true); assert.deepEqual(reused.replyCandidate, one.replyCandidate);
  assert.deepEqual(reused.nextState, one.nextState);
  f.facts.closeEventId = "native-close-event";
  const two = f.prepare(one.nextState, "host-closed", f.closeBody());
  const lateHost = f.prepare(two.nextState, "host", f.body);
  assert.equal(lateHost.nextState.revision, 2); assert.deepEqual(lateHost.replyCandidate, one.replyCandidate);
  const lateClose = f.prepare(two.nextState, "host-closed", f.closeBody());
  assert.equal(lateClose.reused, true); assert.equal(lateClose.nextState.revision, 2);
});
test("same operationId with changed content cannot be reinterpreted", () => {
  const f = fixture(), one = f.register();
  const changed = { ...f.body, expectedRevision: 1 };
  assert.throws(() => f.prepare(one.nextState, "host", changed), /operation_conflict/);
  f.facts.closeEventId = "native-close-event";
  assert.throws(() => f.prepare(one.nextState, "host-closed", { ...f.closeBody(), operationId: f.body.operationId }), /operation_conflict/);
});
test("competing candidates require external CAS; this leaf does not pick a committed winner", () => {
  const f = fixture();
  const a = f.register(), b = f.prepare(f.first, "host", { ...f.body, operationId: "competitor" });
  assert.equal(a.nextState.revision, 1); assert.equal(b.nextState.revision, 1);
  assert.equal(a.replyCandidate.durable, false); assert.equal(b.replyCandidate.durable, false);
  assert.equal(f.first.revision, 0);
  assert.throws(() => f.prepare(a.nextState, "host", { ...f.body, operationId: "competitor" }), /revision_conflict/);
});
test("close before host, skipped revision, new host after registration reject", () => {
  const f = fixture(); f.facts.closeEventId = "native-close-event";
  assert.throws(() => f.prepare(f.first, "host-closed", { ...f.closeBody(), expectedRevision: 0 }), /phase_conflict/);
  assert.throws(() => f.prepare(f.first, "host", { ...f.body, expectedRevision: 2 }), /revision_conflict/);
  const one = f.register();
  assert.throws(() => f.prepare(one.nextState, "host", { ...f.body, operationId: "new-host", expectedRevision: 1 }), /phase_conflict/);
});
for (const key of ["obligationId", "originalTaskId", "executionId", "deviceId", "serial", "agentId", "appSlot", "androidUser", "nonce", "serverEpoch", "agentInstanceId", "handshakeNonce"]) {
  test(`authenticated context rejects mismatched ${key}`, () => {
    const f = fixture();
    if (key === "appSlot" || key === "androidUser") { f.auth.appSlot = "clone"; f.auth.androidUser = 999; }
    else if (key === "deviceId" || key === "serial") { f.auth.deviceId = "adb:other"; f.auth.serial = "other"; }
    else f.auth[key] = "other";
    assert.throws(f.register, /context_mismatch/); assert.equal(f.first.revision, 0);
  });
}
for (const [label, alter] of [
  ["request nonce", f => { f.body.readyNonce = "other"; }],
  ["trusted spawn nonce", f => { f.facts.spawnNonce = "other"; }],
  ["parent instance", f => { f.facts.agentInstanceId = "other"; }],
  ["parent PID", f => { f.body.parentHost.pid += 10; }],
  ["reader PID", f => { f.body.readerHost.pid++; }],
  ["parent birth token", f => { f.body.parentHost.creationToken = "0x1.9a00000000002p+30"; }],
  ["reader birth token", f => { f.body.readerHost.creationToken = "0x1.9a00000000002p+30"; }],
  ["parent audit timestamp", f => { f.body.parentHost.createdAt = "2001-01-01T00:00:00.000Z"; }],
  ["reader audit timestamp", f => { f.body.readerHost.createdAt = "2001-01-01T00:00:00.000Z"; }],
  ["reader machine", f => { f.body.readerHost.machineId = "b".repeat(64); }],
]) test(`wrong ${label} does not grant preparation`, () => {
  const f = fixture(); alter(f); assert.throws(f.register, /wecom_v2_/); assert.equal(f.first.revision, 0);
});
test("nonce alone cannot replace parent/reader facts or genuine close observation", () => {
  const f = fixture(); f.facts.readerHost = { ...f.facts.readerHost, pid: 222 };
  assert.throws(f.register, /host_mismatch/);
  const g = fixture(), one = g.register();
  assert.throws(() => g.prepare(one.nextState, "host-closed", g.closeBody()), /close_unconfirmed/);
  g.facts.closeEventId = "other-native-event";
  assert.throws(() => g.prepare(one.nextState, "host-closed", g.closeBody()), /close_unconfirmed/);
});
test("known instance cannot be substituted between registration and close", () => {
  const f = fixture(), one = f.register(); f.facts.closeEventId = "native-close-event";
  f.facts.readerHost = { ...f.facts.readerHost, ...auditBirth(Date.parse(f.facts.readerHost.createdAt) + 2) };
  const altered = { ...f.closeBody(), readerHost: structuredClone(f.facts.readerHost) };
  assert.throws(() => f.prepare(one.nextState, "host-closed", altered), /host_mismatch/);
});
test("JSON roundtrip only rehydrates structure, never durable ACK or runtime authority", () => {
  const f = fixture(), one = f.register(), parsed = JSON.parse(JSON.stringify(one.nextState));
  const reused = f.prepare(parsed, "host", f.body);
  assert.equal(reused.reused, true); assert.equal(reused.replyCandidate.durable, false);
  f.auth.serverEpoch = "new-server-epoch";
  assert.throws(() => f.prepare(parsed, "host", f.body), /context_mismatch/);
});
for (const [label, alter] of [
  ["phase", s => { s.phase = "verified"; }], ["fence", s => { s.fence = "released"; }],
  ["revision", s => { s.revision = 0; }], ["stored host", s => { s.readerHost.pid++; }],
  ["candidate ACK", s => { s.operations[0].replyCandidate.durable = true; }],
  ["extra operation", s => { s.operations.push(s.operations[0]); }],
]) test(`rehydration rejects tampered ${label}`, () => {
  const f = fixture(), changed = structuredClone(f.register().nextState); alter(changed);
  assert.throws(() => f.prepare(changed, "host", f.body), /state_invalid/);
});
test("v1, HTTP booleans, privilege claims, proof/release actions are not accepted", () => {
  const f = fixture(); assert.throws(() => createWecomV2HostState({ ...f.binding, version: 1 }), /binding_invalid/);
  for (const claim of ["authenticated", "clockAuthority", "spawnConfirmed", "exited", "durable"]) {
    assert.throws(() => f.prepare(f.first, "host", { ...f.body, [claim]: true }), /request_invalid/);
  }
  for (const action of ["proof", "release", "verify", "permit-payload"]) assert.throws(() => f.prepare(f.first, action, f.body), /action_invalid/);
  assert.throws(() => createWecomV2HostPreparer({ readAuthenticatedBinding: true, readParentInstanceFacts: true }), /trusted_providers_required/);
  const invalidFacts = createWecomV2HostPreparer({ readAuthenticatedBinding: () => f.auth, readParentInstanceFacts: () => ({ ...f.facts, authority: true }) });
  assert.throws(() => invalidFacts(f.first, "host", f.body), /instance_unconfirmed/);
});
for (const value of [null, true, [], "authenticated"]) test(`primitive/array context ${JSON.stringify(value)} cannot confer authority`, () => {
  const f = fixture();
  const noAuth = createWecomV2HostPreparer({ readAuthenticatedBinding: () => value, readParentInstanceFacts: () => f.facts });
  const noFacts = createWecomV2HostPreparer({ readAuthenticatedBinding: () => f.auth, readParentInstanceFacts: () => value });
  assert.throws(() => noAuth(f.first, "host", f.body), /binding_invalid/);
  assert.throws(() => noFacts(f.first, "host", f.body), /instance_unconfirmed/);
});
for (const [label, mutate] of [
  ["PID above Windows DWORD", h => { h.pid = 4294967296; }],
  ["nonfinite birth token", h => { h.creationToken = "0x1.0000000000000p+9999"; }],
  ["same-host birth mismatch", h => { h.createdAt = "2000-01-01T00:00:00.000Z"; }],
]) test(`same-source invalid reader facts reject ${label}`, () => {
  const f = fixture(); mutate(f.facts.readerHost); f.body.readerHost = structuredClone(f.facts.readerHost);
  assert.throws(f.register, /host_invalid/);
});
for (const [label, mutate] of [
  ["PID above Windows DWORD", h => { h.pid = 4294967296; }],
  ["nonfinite birth token", h => { h.creationToken = "0x1.0000000000000p+9999"; }],
  ["same-host birth mismatch", h => { h.createdAt = "2000-01-01T00:00:00.000Z"; }],
]) test(`same-source invalid parent facts reject ${label}`, () => {
  const f = fixture(); mutate(f.facts.parentHost); f.body.parentHost = structuredClone(f.facts.parentHost);
  assert.throws(f.register, /host_invalid/);
});
for (const key of ["parentHost", "readerHost"]) {
  test(`${key} accepts positive DWORD maximum with otherwise valid facts`, () => {
    const f = fixture(); f.facts[key].pid = 0xffffffff; f.body[key].pid = 0xffffffff;
    assert.equal(f.register().nextState[key].pid, 0xffffffff);
  });
  test(`${key} rejects finite-token underflow to zero even when both sources match`, () => {
    const f = fixture(); f.facts[key].creationToken = "0x1.0000000000000p-9999";
    f.body[key] = structuredClone(f.facts[key]); assert.throws(f.register, /host_invalid/);
  });
  test(`${key} rejects same-source two millisecond mismatch beyond tolerance`, () => {
    const f = fixture(); f.facts[key].createdAt = new Date(Date.parse(f.facts[key].createdAt) + 2).toISOString();
    f.body[key] = structuredClone(f.facts[key]); assert.throws(f.register, /host_invalid/);
  });
  for (const offset of [-1, 1]) test(`${key} preserves same-host ${offset}ms audit tolerance without restamping`, () => {
    const f = fixture(), rawToken = f.facts[key].creationToken;
    const audit = new Date(Date.parse(f.facts[key].createdAt) + offset).toISOString();
    f.facts[key].createdAt = audit; f.body[key].createdAt = audit;
    const one = f.register();
    assert.equal(one.nextState[key].creationToken, rawToken); assert.equal(one.nextState[key].createdAt, audit);
    assert.equal(one.nextState.fence, "held");
  });
}
