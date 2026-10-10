export function canShareDeviceLockWithScreenControl(lock, ownerUserId, options = {}) {
  const normalizedOwnerUserId = String(ownerUserId || "").trim();
  const allowAdminOverride = options.allowAdminOverride === true;
  return Boolean(
    lock
    && lock.status === "active"
    && lock.lockType === "alipay_name_lookup"
    && normalizedOwnerUserId
    && (allowAdminOverride || String(lock.ownerUserId || "").trim() === normalizedOwnerUserId)
  );
}

export function lookupSessionNeedsHumanAction(lookupSession) {
  if (!lookupSession) return false;
  if (lookupSession.status === "needs_human_verification") return true;
  if (lookupSession.limitReason === "jigsaw_verification") return true;
  const latestResult = Array.isArray(lookupSession.results)
    ? lookupSession.results.find((result) => result?.status !== "queued")
    : null;
  return Boolean(
    latestResult
    && (
      latestResult.status === "needs_human_verification"
      || latestResult.limitReason === "jigsaw_verification"
    )
  );
}

export function canShareLookupSessionWithScreenControl(lock, ownerUserId, lookupSession, options = {}) {
  const allowAdminOverride = options.allowAdminOverride === true;
  return Boolean(
    canShareDeviceLockWithScreenControl(lock, ownerUserId, options)
    && lookupSession
    && lookupSession.sessionId === lock.taskId
    && lookupSession.deviceId === lock.deviceId
    && (allowAdminOverride || lookupSession.userId === String(ownerUserId || "").trim())
    && ["ready", "choosing_account", "needs_human_verification"].includes(lookupSession.status)
    && !lookupSession.pendingJobId
  );
}

export function findScreenControlLockConflict(locks, deviceId, ownerUserId, options = {}) {
  const normalizedDeviceId = String(deviceId || "").trim();
  return (Array.isArray(locks) ? locks : []).find((lock) => (
    lock?.status === "active"
    && String(lock.deviceId || "").trim() === normalizedDeviceId
    && !canShareDeviceLockWithScreenControl(lock, ownerUserId, options)
  )) || null;
}

export function remainingActiveDeviceLock(locks, releasedLock) {
  if (!releasedLock?.deviceId) return null;
  return (Array.isArray(locks) ? locks : []).find((lock) => (
    lock?.status === "active"
    && lock.deviceId === releasedLock.deviceId
    && lock.lockId !== releasedLock.lockId
  )) || null;
}
