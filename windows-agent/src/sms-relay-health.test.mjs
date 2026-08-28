import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmsRelayHealthArgs,
  buildSmsRelayRecoverArgs,
  missingSmsRelayHealth,
  parseSmsRelayHealth,
  shouldRecoverSmsRelay,
  usesSmsRelayManagedSmsPath
} from "./sms-relay-health.mjs";

test("parses the protected SmsRelay health provider without message content", () => {
  const output = 'Row: 0 status_json={"defaultSmsApp":true,"defaultSmsPackage":"com.ztqc.smsrelay","serviceAlive":true,"receiveSmsGranted":true,"readSmsGranted":true,"batteryOptimizationIgnored":true,"pendingUploadCount":4,"localMessageCount":7,"providerWriteFailureCount":1,"oldestPendingUploadAgeMillis":2000,"nextUploadRetryInMillis":800,"lastReceiveAt":100,"lastServiceAliveAt":200,"lastSyncAt":300,"lastSyncStatus":"incremental_ok"}';
  const health = parseSmsRelayHealth(output, "2026-08-21T00:00:00.000Z");
  assert.equal(health.defaultSmsApp, true);
  assert.equal(health.collectionMode, "health_only");
  assert.equal(health.pendingUploadCount, 4);
  assert.equal(health.localMessageCount, 7);
  assert.equal(health.providerWriteFailureCount, 1);
  assert.equal(Object.hasOwn(health, "body"), false);
});

test("recovers only an installed default relay whose service is stale", () => {
  const healthy = { installed: true, defaultSmsApp: true, receiveSmsGranted: true, serviceAlive: true };
  assert.equal(shouldRecoverSmsRelay(healthy), false);
  assert.equal(shouldRecoverSmsRelay({ ...healthy, serviceAlive: false }), true);
  assert.equal(shouldRecoverSmsRelay({ ...healthy, defaultSmsApp: false, serviceAlive: false }), false);
  assert.equal(shouldRecoverSmsRelay(missingSmsRelayHealth()), false);
});

test("builds exact package-scoped health and recovery commands", () => {
  assert.deepEqual(buildSmsRelayHealthArgs(), ["shell", "content", "query", "--uri", "content://com.ztqc.smsrelay.health/status"]);
  assert.deepEqual(buildSmsRelayRecoverArgs(), [
    "shell", "am", "start", "--user", "0",
    "-n", "com.ztqc.smsrelay/.RecoveryActivity",
    "--activity-no-animation", "--activity-no-history"
  ]);
});

test("an installed SmsRelay disables every legacy Windows SMS collection path", () => {
  assert.equal(usesSmsRelayManagedSmsPath({ installed: true, defaultSmsApp: true }), true);
  assert.equal(usesSmsRelayManagedSmsPath({ installed: true, defaultSmsApp: false }), true);
  assert.equal(usesSmsRelayManagedSmsPath({ installed: false, status: "not_installed" }), false);
  assert.equal(usesSmsRelayManagedSmsPath(undefined), false);
});
