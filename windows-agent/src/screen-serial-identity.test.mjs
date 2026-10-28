import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { resolveOnlineAdbSerial } from "./adb-serial-identity.mjs";
import {
  createScreenStreamManager, applyScreenDeviceProfile, screenControlIsolationEnabled,
  screenSourceRecoveryEnabled, screenViewerKeyframeResetEnabled,
  resolveScreenTransportPacingBitRate, resolveScreenTransportPacketsPerBurst,
  resolveScreenTransportAdaptivePacing, resolveScreenTransportReceiverFeedback
} from "./screen-stream.mjs";

function fixture({ devices = [{ adbSerial: "testab12", state: "device" }], profiles, resolver } = {}) {
  const events = [];
  const statuses = [];
  const manager = createScreenStreamManager({
    config: { screenMaxConcurrentSessions: 15, screenDeviceProfiles: profiles },
    agentDir: "/unused-test-only",
    resolveSerial: resolver || (serial => resolveOnlineAdbSerial(serial, devices)),
    preemptSerial: serial => events.push(["preempt", serial]),
    reserveSerial: serial => { events.push(["reserve", serial]); return true; },
    releaseSerial: serial => events.push(["release", serial]),
    waitForSerialIdle: async serial => { events.push(["idle", serial]); },
    beforeSessionStart: async serial => { events.push(["prepare", serial]); },
    afterSessionEnd: async serial => { events.push(["resume", serial]); }
  });
  manager.socket = { readyState: 1, send: value => statuses.push(JSON.parse(value)) };
  // No ADB, socket connection, scrcpy, phone or process is started by this fixture.
  manager.runSession = session => { events.push(["stream", session.serial]); return new Promise(() => {}); };
  return { manager, events, statuses };
}

test("all lifecycle callbacks use the exact observed serial and keep an unrelated session untouched", async () => {
  const { manager, events } = fixture();
  const unrelated = { sessionId: "other", serial: "another", closed: false };
  manager.sessions.set("other", unrelated);
  await manager.startSession({ sessionId: "target", adbSerial: "TESTAB12" });
  assert.equal(manager.sessions.get("target").serial, "testab12");
  assert.deepEqual(events, ["preempt", "reserve", "idle", "prepare", "stream"].map(kind => [kind, "testab12"]));
  await manager.closeSession("target", "test_end", false);
  assert.deepEqual(events.slice(-2), [["release", "testab12"], ["resume", "testab12"]]);
  assert.equal(manager.sessions.get("other"), unrelated);
  assert.equal(unrelated.closed, false);
});

for (const state of ["offline", "unauthorized", "missing"]) {
  test(`${state} inventory never preempts, reserves or prepares the device`, async () => {
    const { manager, events, statuses } = fixture({ devices: [{ adbSerial: "testab12", state }] });
    await manager.startSession({ sessionId: "rejected", adbSerial: "TESTAB12" });
    assert.deepEqual(events, []);
    assert.equal(manager.sessions.size, 0);
    assert.equal(statuses.at(-1).status, "failed");
    assert.doesNotMatch(JSON.stringify(statuses), /shell 通道无响应/);
  });
}

test("unknown and ambiguous identity/profile are rejected before background preemption", async () => {
  for (const options of [
    { devices: [] },
    { devices: [{ adbSerial: "testab12", state: "device" }, { adbSerial: "TESTAB12", state: "device" }] },
    { profiles: { testab12: {}, TESTAB12: {} } }
  ]) {
    const { manager, events, statuses } = fixture(options);
    await manager.startSession({ sessionId: "rejected", adbSerial: "TESTAB12" });
    assert.deepEqual(events, []);
    assert.equal(manager.sessions.size, 0);
    assert.equal(statuses.at(-1).status, "failed");
  }
});

test("a stop during identity resolution cannot resurrect the session", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { manager, events } = fixture({ resolver: () => pending });
  const starting = manager.startSession({ sessionId: "cancelled", adbSerial: "TESTAB12" });
  await manager.handleMessage({ type: "screen_stop", sessionId: "cancelled", reason: "test_stop" });
  resolve("testab12");
  await starting;
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(events, []);
});

test("a case alias cannot take over an already active physical device", async () => {
  const { manager, events, statuses } = fixture();
  await manager.startSession({ sessionId: "first", adbSerial: "testab12" });
  const count = events.length;
  await manager.startSession({ sessionId: "alias", adbSerial: "TESTAB12" });
  assert.equal(events.length, count);
  assert.equal(manager.sessions.size, 1);
  assert.equal(statuses.at(-1).status, "failed");
  await manager.closeSession("first", "test_end", false);
});

test("correcting serial casing preserves every per-device media/profile policy", () => {
  const config = { screenDeviceProfiles: { TESTAB12: {
    maxSize: 1280, maxFps: 30, videoBitRate: 5_000_000,
    transportPacingBitRate: 12_000_000, transportPacketsPerBurst: 2,
    isolateControl: true, sourceRecovery: true, viewerKeyframeReset: true,
    transportAdaptivePacing: true, transportReceiverFeedback: true
  } } };
  const requestedOptions = { maxSize: 1600, maxFps: 60, videoBitRate: 6_000_000 };
  const settings = serial => [
    applyScreenDeviceProfile({ config, requestedOptions, serial }),
    resolveScreenTransportPacingBitRate({ config, requestedOptions, serial }),
    resolveScreenTransportPacketsPerBurst({ config, requestedOptions, serial }),
    resolveScreenTransportAdaptivePacing({ config, requestedOptions, serial }),
    resolveScreenTransportReceiverFeedback({ config, requestedOptions, serial }),
    screenControlIsolationEnabled(config, serial),
    screenSourceRecoveryEnabled(config, serial),
    screenViewerKeyframeResetEnabled(config, serial)
  ];
  const exact = settings("TESTAB12");
  assert.deepEqual(exact[0], { maxSize: 1280, maxFps: 30, videoBitRate: 5_000_000 });
  assert.equal(exact[1], 12_000_000);
  assert.equal(exact[2], 2);
  assert.deepEqual(settings("testab12"), exact);
  assert.deepEqual(settings("TeStAb12"), exact);
  assert.deepEqual(applyScreenDeviceProfile({ config, requestedOptions, serial: "other" }), requestedOptions);
});

test("the production Agent wires resolution to the current local discovery snapshot", async () => {
  const source = await fs.readFile(new URL("./index.mjs", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*resolveOnlineAdbSerial\s*\}\s*from\s*["']\.\/adb-serial-identity\.mjs["']/);
  assert.match(source, /resolveSerial:\s*\(serial\)\s*=>\s*resolveOnlineAdbSerial\(serial,\s*lastDevices\)/);
});
