export function isSerialReservedForBackgroundWork(serial, taskSerials, screenSerials) {
  const normalizedSerial = String(serial || "").trim();
  if (!normalizedSerial) return false;
  return Boolean(taskSerials?.has(normalizedSerial) || screenSerials?.has(normalizedSerial));
}

export function shouldScheduleSmsBackground({ enabled, skipSms, activeAutomationTask } = {}) {
  // Foreground work reserves only its exact serial. Per-device workers already
  // skip reserved serials, so one automation task must not freeze SMS
  // collection for every other phone on this Windows host.
  return Boolean(enabled) && !skipSms;
}
