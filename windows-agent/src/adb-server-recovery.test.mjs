import assert from "node:assert/strict";
import test from "node:test";
import { createAdbServerRecovery } from "./adb-server-recovery.mjs";

test("does not restart ADB for one transient scan failure", async () => {
  const recovery = createAdbServerRecovery({ recoverAfterFailures: 2 });
  const result = await recovery.recover({ startServer() {}, restartServer() {} });
  assert.equal(result.action, "wait");
  assert.equal(result.attempted, false);
});

test("starts a missing daemon but never kills the host ADB server automatically", async () => {
  let starts = 0;
  let restarts = 0;
  let clock = 0;
  const recovery = createAdbServerRecovery({ now: () => clock, recoverAfterFailures: 2, hardRecoverAfterFailures: 3, cooldownMs: 1 });
  await recovery.recover({ startServer() { starts += 1; }, restartServer() { restarts += 1; } });
  clock += 2;
  await recovery.recover({ startServer() { starts += 1; }, restartServer() { restarts += 1; } });
  clock += 2;
  const result = await recovery.recover({ startServer() { starts += 1; }, restartServer() { restarts += 1; } });
  assert.equal(starts, 1);
  assert.equal(restarts, 0);
  assert.equal(result.action, "maintenance_required");
  assert.equal(result.attempted, false);
});

test("defers the disruptive recovery while a phone is busy", async () => {
  let clock = 0;
  const recovery = createAdbServerRecovery({ now: () => clock, recoverAfterFailures: 1, hardRecoverAfterFailures: 2, cooldownMs: 1 });
  await recovery.recover({ startServer() {}, restartServer() {} });
  clock += 2;
  const result = await recovery.recover({ startServer() {}, restartServer() {}, busy: true });
  assert.equal(result.action, "deferred_busy");
});
