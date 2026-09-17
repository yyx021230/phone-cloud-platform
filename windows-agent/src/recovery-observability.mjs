const DEFAULT_EVENT_LIMIT = 160;

export function createRecoveryEventJournal(options = {}) {
  const now = options.now || Date.now;
  const limit = Math.max(20, Number(options.limit || DEFAULT_EVENT_LIMIT));
  const dedupeWindowMs = Math.max(0, Number(options.dedupeWindowMs ?? 60_000));
  let sequence = 0;
  let events = normalizeEvents(options.initialEvents, limit);
  const observedStates = new Map(Object.entries(options.initialStates || {}).map(([key, value]) => [normalizeSerial(key), String(value || "")]).filter(([key]) => key));

  function record(input = {}) {
    const atMs = normalizeTime(input.at, now());
    const serial = String(input.serial || "").trim();
    const type = String(input.type || "status").slice(0, 60);
    const reason = String(input.reason || "").slice(0, 160);
    const signature = [type, normalizeSerial(serial), reason, String(input.state || ""), String(input.attempt || "")].join("|");
    const previous = events[events.length - 1];
    if (previous?.signature === signature && atMs - new Date(previous.at).getTime() < dedupeWindowMs) return null;
    sequence += 1;
    const event = normalizeEvent({
      ...input,
      id: String(input.id || `${atMs}-${sequence}`),
      at: new Date(atMs).toISOString(),
      serial,
      type,
      reason,
      signature
    });
    events = [...events, event].slice(-limit);
    return event;
  }

  function observeTransitions(observations = []) {
    for (const observation of Array.isArray(observations) ? observations : []) {
      const key = normalizeSerial(observation?.serial);
      const state = String(observation?.state || "");
      if (!key || !state) continue;
      const previousState = observedStates.get(key) || "";
      observedStates.set(key, state);
      if (!previousState) {
        if (state !== "adb_device") record({ type: "detected", serial: observation.serial, state, severity: "warning" });
        continue;
      }
      if (previousState === state) continue;
      record({
        type: state === "adb_device" ? "recovered" : "state_changed",
        serial: observation.serial,
        state,
        previousState,
        severity: state === "adb_device" ? "success" : "warning"
      });
    }
  }

  return {
    record,
    observeTransitions,
    events: (max = limit) => events.slice(-Math.max(1, Number(max || limit))),
    snapshot: () => ({
      events: [...events],
      observedStates: Object.fromEntries(observedStates)
    })
  };
}

export function buildRecoveryQueue(options = {}) {
  const observations = Array.isArray(options.observations) ? options.observations : [];
  const attempts = normalizeAttemptMap(options.attemptsBySerial);
  const devices = indexDevices(options.devices);
  const excludedSerials = new Set((options.excludedSerials || []).map(normalizeSerial));
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
  const rows = [];

  for (const observation of observations) {
    const key = normalizeSerial(observation?.serial);
    if (!key) continue;
    if (excludedSerials.has(key)) continue;
    const attempt = attempts.get(key) || {};
    const state = String(observation?.state || "unknown");
    if (state === "adb_device" && !attempt.inProgress && !attempt.quarantinedAt) continue;
    // Historical platform devices which are no longer physically enumerated
    // remain useful in the normal device inventory, but they are not waiting
    // for an automatic recovery action. Do not inflate the recovery queue with
    // unplugged or currently unobservable phones.
    if (["physically_absent", "inventory_unavailable"].includes(state)
      && !attempt.inProgress
      && !attempt.quarantinedAt) continue;
    const device = devices.get(key) || observation.adb || {};
    rows.push({
      serial: String(observation.serial || device.adbSerial || "").slice(0, 160),
      deviceId: String(device.deviceId || "").slice(0, 160),
      deviceName: String(device.deviceName || device.name || device.displayName || observation.serial || "未知设备").slice(0, 160),
      state,
      physicalPresent: Boolean(observation.physicalPresent),
      attempts: boundedInteger(attempt.attempts, 0, maxAttempts),
      maxAttempts,
      mode: String(attempt.lastMode || "").slice(0, 80),
      lastAttemptAt: toIso(attempt.lastAttemptAt),
      nextActionAt: toIso(attempt.nextRetryAt),
      inProgress: Boolean(attempt.inProgress),
      quarantined: Boolean(attempt.quarantinedAt),
      quarantinedAt: toIso(attempt.quarantinedAt),
      targetType: String(attempt.targetType || "").slice(0, 80),
      lastError: String(attempt.lastError || "").slice(0, 300),
      rootProblem: String(observation.physical?.rootProblem || "").slice(0, 120),
      adbInterfaceProblem: String(observation.physical?.adbInterfaceProblem || "").slice(0, 120)
    });
  }

  return rows.sort((left, right) => {
    const priorityDelta = recoveryPriority(left) - recoveryPriority(right);
    if (priorityDelta) return priorityDelta;
    const timeDelta = new Date(left.nextActionAt || 0).getTime() - new Date(right.nextActionAt || 0).getTime();
    if (timeDelta) return timeDelta;
    return left.deviceName.localeCompare(right.deviceName, "zh-CN", { numeric: true });
  });
}

function normalizeEvents(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeEvent)
    .filter((item) => item.at && item.type)
    .slice(-limit);
}

function normalizeEvent(input = {}) {
  return {
    id: String(input.id || "").slice(0, 120),
    at: String(input.at || "").slice(0, 80),
    type: String(input.type || "").slice(0, 60),
    severity: ["success", "warning", "error", "info"].includes(input.severity) ? input.severity : "info",
    serial: String(input.serial || "").slice(0, 160),
    state: String(input.state || "").slice(0, 80),
    previousState: String(input.previousState || "").slice(0, 80),
    attempt: boundedInteger(input.attempt, 0, 100),
    maxAttempts: boundedInteger(input.maxAttempts, 0, 100),
    mode: String(input.mode || "").slice(0, 80),
    reason: String(input.reason || "").slice(0, 160),
    result: String(input.result || "").slice(0, 300),
    nextActionAt: String(input.nextActionAt || "").slice(0, 80),
    targetType: String(input.targetType || "").slice(0, 80),
    signature: String(input.signature || "").slice(0, 500)
  };
}

function normalizeAttemptMap(value) {
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [normalizeSerial(key), item || {}]));
  return new Map((Array.isArray(value) ? value : []).map((item) => [normalizeSerial(item?.serial), item || {}]).filter(([key]) => key));
}

function indexDevices(value) {
  const rows = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
  return new Map(rows.map((item) => [normalizeSerial(item?.adbSerial || item?.serial), item || {}]).filter(([key]) => key));
}

function normalizeSerial(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeTime(value, fallback) {
  const numeric = typeof value === "number" ? value : new Date(value || 0).getTime();
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toIso(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : "";
}

function boundedInteger(value, min, max) {
  const numeric = Number(value || 0);
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? Math.round(numeric) : min));
}

function recoveryPriority(row) {
  if (row.inProgress) return 0;
  if (row.quarantined) return 1;
  if (row.state === "adb_unauthorized") return 2;
  if (row.physicalPresent) return 3;
  return 4;
}
