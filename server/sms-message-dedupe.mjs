function compactText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function compactAddress(value) {
  return compactText(value).replace(/[\s()（）-]+/g, "");
}

function messageTime(value) {
  const time = new Date(value?.messageAt || value?.receivedAt || value?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : NaN;
}

export function smsSourceFamily(source) {
  return String(source || "").toLowerCase().includes("notification") ? "notification" : "provider";
}

export function isSemanticSmsDuplicate(existing, incoming, toleranceMs = 120_000) {
  if (!existing || !incoming || existing.deviceId !== incoming.deviceId) return false;
  if (smsSourceFamily(existing.source) === smsSourceFamily(incoming.source)) return false;
  const existingBody = compactText(existing.body);
  const incomingBody = compactText(incoming.body);
  if (!existingBody || existingBody !== incomingBody) return false;
  const existingAddress = compactAddress(existing.address);
  const incomingAddress = compactAddress(incoming.address);
  if (existingAddress && incomingAddress && existingAddress !== incomingAddress) return false;
  const left = messageTime(existing);
  const right = messageTime(incoming);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= toleranceMs;
}

export function findSemanticSmsDuplicate(messages, incoming, toleranceMs = 120_000) {
  const incomingTime = messageTime(incoming);
  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isSemanticSmsDuplicate(message, incoming, toleranceMs)) continue;
    const distance = Math.abs(messageTime(message) - incomingTime);
    if (distance >= nearestDistance) continue;
    nearest = message;
    nearestDistance = distance;
  }
  return nearest;
}

function filled(value) {
  return value !== undefined && value !== null && value !== "";
}

export function mergeCrossSourceSms(existing, incoming) {
  const provider = smsSourceFamily(incoming?.source) === "provider" ? incoming : existing;
  const supplement = provider === incoming ? existing : incoming;
  const merged = { ...supplement, ...provider };
  for (const key of ["address", "body", "code", "platform", "phoneNumber", "smsId", "threadId", "dateSent", "status", "subscriptionId", "slotIndex"]) {
    if (!filled(merged[key]) && filled(supplement?.[key])) merged[key] = supplement[key];
  }
  merged.messageId = existing.messageId;
  merged.messageKey = provider?.messageKey || existing.messageKey;
  merged.createdAt = existing.createdAt;
  merged.sourceAliases = [...new Set([
    ...(Array.isArray(existing.sourceAliases) ? existing.sourceAliases : []),
    existing.source,
    ...(Array.isArray(incoming.sourceAliases) ? incoming.sourceAliases : []),
    incoming.source
  ].filter(Boolean))];
  return merged;
}
