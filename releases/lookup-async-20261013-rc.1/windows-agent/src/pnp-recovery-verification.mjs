export function observeAdbRecoveryVerification(previous = {}, options = {}) {
  const state = previous && typeof previous === "object" ? previous : {};
  const now = finiteTime(options.now, Date.now());
  const online = options.online === true;
  const minStableMs = Math.max(0, Number(options.minStableMs ?? 60_000));
  const minStableScans = Math.max(1, Number(options.minStableScans ?? 3));

  if (!online) {
    if (!state.verificationStartedAt && !state.verificationScans) {
      return { status: "offline", confirmed: false, state };
    }
    const next = { ...state };
    delete next.verificationStartedAt;
    delete next.verificationScans;
    delete next.verificationLastSeenAt;
    return { status: "regressed", confirmed: false, state: next };
  }

  const startedAt = finiteTime(state.verificationStartedAt, now);
  const scans = Math.max(0, Number(state.verificationScans || 0)) + 1;
  const elapsedMs = Math.max(0, now - startedAt);
  const next = {
    ...state,
    verificationStartedAt: startedAt,
    verificationScans: scans,
    verificationLastSeenAt: now
  };
  const confirmed = scans >= minStableScans && elapsedMs >= minStableMs;
  return {
    status: confirmed ? "confirmed" : "verifying",
    confirmed,
    elapsedMs,
    scans,
    state: next
  };
}

export function observePhysicalAbsence(previous = {}, options = {}) {
  const state = previous && typeof previous === "object" ? previous : {};
  const now = finiteTime(options.now, Date.now());
  const absent = options.absent === true;
  const minAbsentMs = Math.max(0, Number(options.minAbsentMs ?? 90_000));

  if (!absent) {
    if (!state.absentSince) return { reset: false, state };
    const next = { ...state };
    delete next.absentSince;
    return { reset: false, state: next };
  }

  const absentSince = finiteTime(state.absentSince, now);
  const next = { ...state, absentSince };
  return {
    reset: now - absentSince >= minAbsentMs,
    absentMs: Math.max(0, now - absentSince),
    state: next
  };
}

function finiteTime(value, fallback) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}
