export function isSerialReservedForBackgroundWork(serial, taskSerials, screenSerials) {
  const normalizedSerial = String(serial || "").trim();
  if (!normalizedSerial) return false;
  return Boolean(taskSerials?.has(normalizedSerial) || screenSerials?.has(normalizedSerial));
}
