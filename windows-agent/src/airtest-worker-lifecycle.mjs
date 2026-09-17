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
