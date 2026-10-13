import assert from "node:assert/strict";
import test from "node:test";
import { ScreenSessionRegistry } from "./screen-sessions.mjs";

test("creates a device-bound session with a one-time browser token", () => {
  const registry = new ScreenSessionRegistry({ now: () => 1_000, ttlMs: 60_000 });
  const created = registry.create({
    deviceId: "device-1",
    agentId: "agent-1",
    adbSerial: "serial-1",
    userId: "user-1",
    requestedQualityProfile: "smooth"
  });

  assert.equal(created.session.deviceId, "device-1");
  assert.equal(created.session.status, "connecting");
  assert.equal(created.session.requestedQualityProfile, "smooth");
  assert.ok(created.browserToken.length >= 32);
  assert.equal(registry.authorizeBrowser(created.session.sessionId, created.browserToken, "user-1").ok, true);
  assert.equal(registry.authorizeBrowser(created.session.sessionId, created.browserToken).ok, true);
  assert.equal(registry.authorizeBrowser(created.session.sessionId, "wrong", "user-1").ok, false);
});

test("rejects a second active session for the same device", () => {
  const registry = new ScreenSessionRegistry({ now: () => 1_000 });
  registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });

  assert.throws(
    () => registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-2" }),
    (error) => error.code === "device_screen_busy"
  );
  assert.equal(registry.activeCount(), 1);
});

test("expires sessions and releases them from the active device index", () => {
  let now = 1_000;
  const registry = new ScreenSessionRegistry({ now: () => now, ttlMs: 30_000 });
  const first = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  now = 32_000;

  const expired = registry.expire();
  assert.equal(expired[0].sessionId, first.session.sessionId);
  assert.equal(registry.get(first.session.sessionId).status, "expired");
  assert.equal(registry.activeCount(), 0);
  assert.doesNotThrow(() => registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-2" }));
});

test("only the owning user or an admin can inspect and stop a session", () => {
  const registry = new ScreenSessionRegistry({ now: () => 1_000 });
  const created = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });

  assert.equal(registry.canAccess(created.session, { role: "user", userId: "user-1" }), true);
  assert.equal(registry.canAccess(created.session, { role: "user", userId: "user-2" }), false);
  assert.equal(registry.canAccess(created.session, { role: "admin", userId: "admin" }), true);
});

test("assigns distinct fixed media paths and reuses a released slot", () => {
  const registry = new ScreenSessionRegistry({ now: () => 1_000, mediaPaths: ["pc/slot-1", "pc/slot-2"] });
  const first = registry.create({ deviceId: "device-1", agentId: "agent-1", adbSerial: "serial-1", userId: "user-1" });
  const second = registry.create({ deviceId: "device-2", agentId: "agent-1", adbSerial: "serial-2", userId: "user-2" });

  assert.equal(first.session.mediaPath, "pc/slot-1");
  assert.equal(second.session.mediaPath, "pc/slot-2");
  assert.throws(
    () => registry.create({ deviceId: "device-3", agentId: "agent-1", adbSerial: "serial-3", userId: "user-3" }),
    (error) => error.code === "screen_media_capacity_exhausted"
  );
  registry.close(first.session.sessionId);
  const reused = registry.create({ deviceId: "device-3", agentId: "agent-1", adbSerial: "serial-3", userId: "user-3" });
  assert.equal(reused.session.mediaPath, "pc/slot-1");
});
