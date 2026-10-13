import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpenLookupDeviceAllowed,
  normalizeExternalReference,
  openLookupRequestFingerprint,
  parseOpenNameLookupClients,
  publicOpenLookupSession
} from "./open-name-lookup-api.mjs";

test("open name lookup clients require a user, device allowlist and strong secret", () => {
  const clients = parseOpenNameLookupClients(JSON.stringify([
    { clientId: "partner-a", secret: "x".repeat(32), username: "External_User", deviceIds: ["adb:ONE"] },
    { clientId: "duplicate-user", secret: "y".repeat(32), username: "external_user", deviceIds: ["adb:TWO"] },
    { clientId: "weak", secret: "short", username: "user", deviceIds: ["adb:TWO"] }
  ]));
  assert.equal(clients.size, 1);
  assert.deepEqual(clients.get("partner-a"), {
    clientId: "partner-a", secret: "x".repeat(32), username: "external_user",
    deviceIds: ["adb:ONE"]
  });
  assert.equal(isOpenLookupDeviceAllowed(clients.get("partner-a"), "adb:ONE"), true);
  assert.equal(isOpenLookupDeviceAllowed(clients.get("partner-a"), "adb:TWO"), false);
  assert.equal(clients.has("duplicate-user"), false);
});

test("external references and idempotency fingerprints are stable", () => {
  assert.equal(normalizeExternalReference("order-123456", "client_reference"), "order-123456");
  assert.throws(() => normalizeExternalReference("short", "client_reference"), /invalid_client_reference/);
  assert.equal(openLookupRequestFingerprint({ b: 2, a: 1 }), openLookupRequestFingerprint({ a: 1, b: 2 }));
  assert.notEqual(openLookupRequestFingerprint({ a: 1 }), openLookupRequestFingerprint({ a: 2 }));
});

test("open session response masks phones and exposes an explicit manual action", () => {
  const response = publicOpenLookupSession({
    sessionId: "session-1", deviceId: "adb:ONE", status: "ready", pendingJobId: "", results: [{
      resultId: "query-1", clientReference: "order-123456", phoneNumber: "13800000000",
      status: "needs_human_verification", limitReason: "jigsaw_verification"
    }]
  });
  assert.equal(response.results[0].phoneNumber, "138****0000");
  assert.equal(response.humanAction.required, true);
  assert.equal(response.humanAction.type, "manual_jigsaw_verification");
  assert.equal(response.humanAction.resumeAllowed, true);
});

test("session-level puzzle is manual while exhausted automatic account rotation is a queue state", () => {
  const puzzle = publicOpenLookupSession({
    sessionId: "session-start-puzzle", status: "ready", limitReason: "jigsaw_verification", results: []
  });
  assert.deepEqual(puzzle.humanAction, {
    required: true,
    type: "manual_jigsaw_verification",
    reason: "jigsaw_verification",
    queryId: "",
    resumeAllowed: false
  });
  const switchAccount = publicOpenLookupSession({
    sessionId: "session-switch", status: "ready", requiresAccountSwitch: true, limitReason: "daily_limit", results: []
  });
  assert.equal(switchAccount.humanAction.required, false);
  assert.equal(switchAccount.queueState.status, "paused");
  assert.equal(switchAccount.queueState.action, "end_session_and_select_another_device");
  const rotationInProgress = publicOpenLookupSession({
    sessionId: "session-rotating", status: "querying", pendingJobId: "job-1",
    requiresAccountSwitch: true, limitReason: "device_risk", queuedCount: 2, results: []
  });
  assert.equal(rotationInProgress.queueState.status, "running");
  assert.equal(rotationInProgress.humanAction.required, false);
});

test("a human-verification blocker remains visible behind more than 500 queued results", () => {
  const queued = Array.from({ length: 501 }, (_, index) => ({
    resultId: `queued-${index}`, status: "queued", queuePosition: index + 1
  }));
  const response = publicOpenLookupSession({
    sessionId: "large-queue", status: "ready", queuedCount: queued.length,
    results: [...queued, { resultId: "blocked-original", status: "needs_human_verification", limitReason: "jigsaw_verification" }]
  });
  assert.equal(response.results.length, 500);
  assert.equal(response.resultsTruncated, true);
  assert.equal(response.humanAction.queryId, "blocked-original");
  assert.equal(response.humanAction.resumeAllowed, true);
});
