import assert from "node:assert/strict";
import test from "node:test";
import {
  canShareDeviceLockWithScreenControl,
  canShareLookupSessionWithScreenControl,
  findScreenControlLockConflict,
  lookupSessionNeedsHumanAction,
  remainingActiveDeviceLock
} from "./device-lock-compatibility.mjs";

const lookupLock = {
  lockId: "lookup-lock",
  lockType: "alipay_name_lookup",
  deviceId: "device-1",
  ownerUserId: "user-1",
  status: "active"
};

test("allows the lookup initiator to add screen control on the same device", () => {
  assert.equal(canShareDeviceLockWithScreenControl(lookupLock, "user-1"), true);
  assert.equal(findScreenControlLockConflict([lookupLock], "device-1", "user-1"), null);
});

test("only shares a lookup session while its automation worker is idle", () => {
  const readySession = {
    sessionId: "lookup-session",
    deviceId: "device-1",
    userId: "user-1",
    status: "ready",
    pendingJobId: ""
  };
  const sessionLock = { ...lookupLock, taskId: readySession.sessionId };
  assert.equal(canShareLookupSessionWithScreenControl(sessionLock, "user-1", readySession), true);
  assert.equal(canShareLookupSessionWithScreenControl(sessionLock, "user-1", { ...readySession, status: "querying", pendingJobId: "job-1" }), false);
  assert.equal(canShareLookupSessionWithScreenControl(sessionLock, "user-1", { ...readySession, status: "starting" }), false);
});

test("allows screen control when a puzzle or human verification needs manual action", () => {
  const explicitHumanSession = {
    sessionId: "lookup-session",
    deviceId: "device-1",
    userId: "user-1",
    status: "needs_human_verification",
    pendingJobId: ""
  };
  const sessionLock = { ...lookupLock, taskId: explicitHumanSession.sessionId };
  assert.equal(canShareLookupSessionWithScreenControl(sessionLock, "user-1", explicitHumanSession), true);
  assert.equal(lookupSessionNeedsHumanAction(explicitHumanSession), true);
  assert.equal(lookupSessionNeedsHumanAction({
    ...explicitHumanSession,
    status: "ready",
    results: [{ status: "needs_human_verification" }]
  }), true);
  assert.equal(lookupSessionNeedsHumanAction({
    ...explicitHumanSession,
    status: "ready",
    limitReason: "jigsaw_verification"
  }), true);
  assert.equal(lookupSessionNeedsHumanAction({
    ...explicitHumanSession,
    status: "ready",
    results: [
      { status: "queued", queuePosition: 2 },
      { status: "queued", queuePosition: 1 },
      { status: "needs_human_verification" }
    ]
  }), true);
});

test("keeps another user's lookup session exclusive", () => {
  assert.equal(canShareDeviceLockWithScreenControl(lookupLock, "user-2"), false);
  assert.equal(findScreenControlLockConflict([lookupLock], "device-1", "user-2"), lookupLock);
});

test("allows an administrator to control another user's idle or human-verification lookup session", () => {
  const readySession = {
    sessionId: "lookup-session",
    deviceId: "device-1",
    userId: "user-1",
    status: "ready",
    pendingJobId: ""
  };
  const sessionLock = { ...lookupLock, taskId: readySession.sessionId };
  const adminAccess = { allowAdminOverride: true };

  assert.equal(canShareDeviceLockWithScreenControl(sessionLock, "admin-1", adminAccess), true);
  assert.equal(canShareLookupSessionWithScreenControl(sessionLock, "admin-1", readySession, adminAccess), true);
  assert.equal(canShareLookupSessionWithScreenControl(
    sessionLock,
    "admin-1",
    { ...readySession, status: "needs_human_verification" },
    adminAccess
  ), true);
  assert.equal(findScreenControlLockConflict([sessionLock], "device-1", "admin-1", adminAccess), null);
});

test("does not let the administrator bypass an active lookup worker", () => {
  const queryingSession = {
    sessionId: "lookup-session",
    deviceId: "device-1",
    userId: "user-1",
    status: "querying",
    pendingJobId: "job-1"
  };
  const sessionLock = { ...lookupLock, taskId: queryingSession.sessionId };

  assert.equal(canShareLookupSessionWithScreenControl(
    sessionLock,
    "admin-1",
    queryingSession,
    { allowAdminOverride: true }
  ), false);
});

test("keeps other task locks and an existing screen session exclusive", () => {
  for (const lockType of ["xhs_qr", "xhs_publish", "sms_wait", "screen_control"]) {
    const lock = { ...lookupLock, lockType };
    assert.equal(findScreenControlLockConflict([lock], "device-1", "user-1"), lock);
    assert.equal(findScreenControlLockConflict(
      [lock],
      "device-1",
      "admin-1",
      { allowAdminOverride: true }
    ), lock);
  }
});

test("ignores released and unrelated-device locks", () => {
  assert.equal(findScreenControlLockConflict([
    { ...lookupLock, status: "released" },
    { ...lookupLock, deviceId: "device-2", ownerUserId: "user-2" }
  ], "device-1", "user-1"), null);
});

test("preserves the other active lock when one compatible lock is released", () => {
  const screenLock = {
    lockId: "screen-lock",
    lockType: "screen_control",
    deviceId: "device-1",
    ownerUserId: "user-1",
    status: "active"
  };
  assert.equal(remainingActiveDeviceLock([lookupLock, screenLock], screenLock), lookupLock);
  assert.equal(remainingActiveDeviceLock([{ ...lookupLock, status: "released" }, screenLock], screenLock), null);
});
