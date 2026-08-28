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

function verificationCodes(value) {
  const candidates = [
    String(value?.code || "").trim(),
    ...[...String(value?.body || "").matchAll(/(?<!\d)\d{4,8}(?!\d)/g)].map((match) => match[0])
  ];
  return [...new Set(candidates.filter((item) => /^\d{4,8}$/.test(item)))];
}

function verificationTemplate(value) {
  return compactText(value?.body)
    .replace(/(?:\*|•|●|·){4,8}/gu, "<otp>")
    .replace(/(?<!\d)\d{4,8}(?!\d)/g, "<otp>");
}

function verificationAddressCompatible(left, right) {
  const leftAddress = compactAddress(left?.address);
  const rightAddress = compactAddress(right?.address);
  if (leftAddress && rightAddress) return leftAddress === rightAddress;
  const leftPlatform = compactText(left?.platform);
  const rightPlatform = compactText(right?.platform);
  return Boolean(leftPlatform && rightPlatform && leftPlatform === rightPlatform);
}

export function isMaskedVerificationSms(value) {
  if (smsSourceFamily(value?.source) !== "notification") return false;
  const body = String(value?.body || "").normalize("NFKC");
  return /(?:验证码|驗證碼|校验码|動態碼|动态码|verification\s*code|\botp\b)/i.test(body)
    && /(?:\*|•|●|·){4,8}/u.test(body)
    && verificationCodes(value).length === 0;
}

function maskedAuthorityCandidates(messages, masked, toleranceMs = 30_000) {
  const maskedTime = messageTime(masked);
  const maskedTemplate = verificationTemplate(masked);
  if (!isMaskedVerificationSms(masked) || !Number.isFinite(maskedTime) || !maskedTemplate) return [];
  return (Array.isArray(messages) ? messages : []).filter((candidate) => {
    if (!candidate || candidate.deviceId !== masked.deviceId) return false;
    if (smsSourceFamily(candidate.source) === "notification") return false;
    const candidateTime = messageTime(candidate);
    if (!Number.isFinite(candidateTime) || Math.abs(candidateTime - maskedTime) > toleranceMs) return false;
    if (verificationCodes(candidate).length !== 1) return false;
    return verificationTemplate(candidate) === maskedTemplate
      && verificationAddressCompatible(candidate, masked);
  });
}

export function findMaskedVerificationAuthority(messages, masked, toleranceMs = 30_000) {
  const candidates = maskedAuthorityCandidates(messages, masked, toleranceMs);
  return candidates.length === 1 ? candidates[0] : null;
}

export function filterMaskedVerificationDuplicates(messages, toleranceMs = 30_000) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((message) => {
    if (!isMaskedVerificationSms(message)) return true;
    return !findMaskedVerificationAuthority(list, message, toleranceMs);
  });
}

export function smsSourceFamily(source) {
  const normalized = String(source || "").toLowerCase();
  if (normalized.includes("notification")) return "notification";
  if (normalized.includes("sms-event") || normalized.includes("sms-relay")) return "event";
  return "provider";
}

export function isSemanticSmsDuplicate(existing, incoming, toleranceMs = 120_000) {
  if (!existing || !incoming || existing.deviceId !== incoming.deviceId) return false;
  if (smsSourceFamily(existing.source) === smsSourceFamily(incoming.source)) return false;
  const left = messageTime(existing);
  const right = messageTime(incoming);
  const distance = Math.abs(left - right);
  if (!Number.isFinite(left) || !Number.isFinite(right) || distance > toleranceMs) return false;
  const existingBody = compactText(existing.body);
  const incomingBody = compactText(incoming.body);
  if (existingBody && existingBody === incomingBody) {
    const existingAddress = compactAddress(existing.address);
    const incomingAddress = compactAddress(incoming.address);
    if (!existingAddress || !incomingAddress || existingAddress === incomingAddress) return true;
  }

  // ColorOS may shorten both the sender and body in the notification while
  // content://sms later exposes the full provider record. Keep this fallback
  // deliberately narrow: only a single identical OTP on both cross-source
  // records, and only inside a short arrival window, can bypass exact text.
  if (distance > Math.min(Number(toleranceMs) || 0, 30_000)) return false;
  const existingCodes = verificationCodes(existing);
  const incomingCodes = verificationCodes(incoming);
  return existingCodes.length === 1
    && incomingCodes.length === 1
    && existingCodes[0] === incomingCodes[0];
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
  if (nearest) return nearest;

  // A masked notification has no recoverable OTP. It may only collapse into a
  // complete source when exactly one same-template authority exists nearby.
  // Requiring a unique candidate prevents assigning the wrong code when two
  // messages arrive in the same short window.
  if (isMaskedVerificationSms(incoming)) {
    return findMaskedVerificationAuthority(messages, incoming, Math.min(Number(toleranceMs) || 0, 30_000));
  }
  if (smsSourceFamily(incoming?.source) !== "notification" && verificationCodes(incoming).length === 1) {
    const masked = (Array.isArray(messages) ? messages : []).filter((message) => {
      if (!isMaskedVerificationSms(message) || message.deviceId !== incoming.deviceId) return false;
      const distance = Math.abs(messageTime(message) - messageTime(incoming));
      return Number.isFinite(distance)
        && distance <= Math.min(Number(toleranceMs) || 0, 30_000)
        && verificationTemplate(message) === verificationTemplate(incoming)
        && verificationAddressCompatible(message, incoming);
    });
    if (masked.length) return masked.sort((a, b) => Math.abs(messageTime(a) - messageTime(incoming)) - Math.abs(messageTime(b) - messageTime(incoming)))[0];
  }
  return null;
}

function filled(value) {
  return value !== undefined && value !== null && value !== "";
}

export function mergeCrossSourceSms(existing, incoming) {
  const priority = { notification: 1, event: 2, provider: 3 };
  const existingPriority = priority[smsSourceFamily(existing?.source)] || 0;
  const incomingPriority = priority[smsSourceFamily(incoming?.source)] || 0;
  const authority = incomingPriority > existingPriority ? incoming : existing;
  const supplement = authority === incoming ? existing : incoming;
  const merged = { ...supplement, ...authority };
  for (const key of ["address", "body", "code", "platform", "phoneNumber", "smsId", "threadId", "dateSent", "status", "subscriptionId", "slotIndex"]) {
    if (!filled(merged[key]) && filled(supplement?.[key])) merged[key] = supplement[key];
  }
  merged.messageId = existing.messageId;
  merged.messageKey = authority?.messageKey || existing.messageKey;
  merged.createdAt = existing.createdAt;
  merged.sourceAliases = [...new Set([
    ...(Array.isArray(existing.sourceAliases) ? existing.sourceAliases : []),
    existing.source,
    ...(Array.isArray(incoming.sourceAliases) ? incoming.sourceAliases : []),
    incoming.source
  ].filter(Boolean))];
  return merged;
}
