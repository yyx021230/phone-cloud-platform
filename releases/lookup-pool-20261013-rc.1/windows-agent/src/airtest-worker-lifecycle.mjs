function serialSet(value) {
  return value instanceof Set ? value : new Set(value || []);
}

function warmUntilForSerial(warmUntilBySerial, serial) {
  if (warmUntilBySerial instanceof Map) return Number(warmUntilBySerial.get(serial) || 0);
  return Number(warmUntilBySerial?.[serial] || 0);
}

export function airtestWorkerLastActivityAt(worker = {}) {
  return Math.max(0, Number(worker.lastUsedAt || worker.startedAt || 0));
}

export function airtestWorkerGracefulStopTimeoutMs(reason = "stop") {
  const normalized = String(reason || "stop");
  if (normalized === "screen_control" || normalized === "xml_uiautomator") return 5_000;
  // A Poco start retry must give the Python worker enough time to remove its
  // device forwards and stop instrumentation. Killing it after 300 ms leaves
  // PocoService half-torn-down, so the replacement worker often attaches to
  // the same stale HTTP channel and fails again.
  if (normalized.startsWith("poco_start_")) return 2_500;
  // A lookup stop now removes Poco forwards, terminates both the target and
  // instrumentation-test packages, waits 250 ms for ActivityManager, and
  // verifies both PIDs.  The historical 300 ms window always killed Python
  // inside that cleanup and orphaned the host `adb am instrument` process.
  // Three seconds is still bounded for an API stop while allowing the normal
  // cleanup path to finish without an Agent/ADB/USB/phone restart.
  if (normalized === "lookup_session_stopped"
      || normalized === "lookup_session_stop_best_effort") return 3_000;
  return 300;
}

export function isAirtestWorkerEvictable({
  serial,
  worker,
  activeSerials,
  screenControlledSerials,
  preflightSerials
} = {}) {
  if (!serial || !worker || worker.exited || worker.stopping || worker.pending) return false;
  if (serialSet(activeSerials).has(serial)) return false;
  if (serialSet(screenControlledSerials).has(serial)) return false;
  if (serialSet(preflightSerials).has(serial)) return false;
  return true;
}

export function selectAirtestWorkerEvictionCandidate({
  workers,
  incomingSerial = "",
  activeSerials,
  screenControlledSerials,
  preflightSerials,
  warmUntilBySerial,
  now = Date.now()
} = {}) {
  const entries = workers instanceof Map ? [...workers.entries()] : [];
  return entries
    .filter(([serial, worker]) => serial !== incomingSerial && isAirtestWorkerEvictable({
      serial,
      worker,
      activeSerials,
      screenControlledSerials,
      preflightSerials
    }))
    .map(([serial, worker]) => ({
      serial,
      worker,
      warm: warmUntilForSerial(warmUntilBySerial, serial) > now,
      lastActivityAt: airtestWorkerLastActivityAt(worker)
    }))
    .sort((left, right) => Number(left.warm) - Number(right.warm)
      || left.lastActivityAt - right.lastActivityAt
      || left.serial.localeCompare(right.serial))[0] || null;
}

export function selectIdleAirtestWorkerSerials({
  workers,
  idleMs,
  activeSerials,
  screenControlledSerials,
  preflightSerials,
  warmUntilBySerial,
  now = Date.now()
} = {}) {
  const thresholdMs = Math.max(0, Number(idleMs || 0));
  if (!(workers instanceof Map)) return [];
  return [...workers.entries()]
    .filter(([serial, worker]) => isAirtestWorkerEvictable({
      serial,
      worker,
      activeSerials,
      screenControlledSerials,
      preflightSerials
    }))
    .filter(([serial]) => warmUntilForSerial(warmUntilBySerial, serial) <= now)
    .filter(([, worker]) => now - airtestWorkerLastActivityAt(worker) >= thresholdMs)
    .sort((left, right) => airtestWorkerLastActivityAt(left[1]) - airtestWorkerLastActivityAt(right[1]))
    .map(([serial]) => serial);
}
