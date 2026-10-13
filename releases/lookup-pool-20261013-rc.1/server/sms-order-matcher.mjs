function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function logicalTargetKey(order) {
  return [
    String(order.clientId || order.userId || order.source || ""),
    String(order.deviceId || ""),
    String(order.phoneNumber || ""),
    String(order.platform || "")
  ].join("|");
}

function normalizedMessagePlatform(message) {
  const explicit = String(message?.platform || "").trim();
  const text = `${String(message?.address || message?.sender || "")} ${String(message?.body || "")}`;
  if (explicit && explicit !== "未知平台") return explicit;
  return text.includes("小红书") ? "小红书" : explicit;
}

function normalizedMessageCode(message) {
  const explicit = String(message?.code || "").trim();
  if (/^\d{4,8}$/.test(explicit)) return explicit;

  const text = String(message?.body || "").replace(/\s+/g, " ");
  const afterKeyword = text.match(
    /(?:验证码|驗證碼|校验码|動態碼|动态码|verification\s*code|\botp\b|\bcode\b)[^\d]{0,18}(\d{4,8})(?!\d)/i
  );
  if (afterKeyword) return afterKeyword[1];
  const beforeKeyword = text.match(
    /(?:^|[^\d])(\d{4,8})(?:\s*为|\s*是)?[^，。,.]{0,20}(?:验证码|驗證碼|校验码|動態碼|动态码|verification\s*code|\botp\b|\bcode\b)/i
  );
  return beforeKeyword?.[1] || "";
}

function isBaseCandidate(order, message, messageTime) {
  if (!order || order.status !== "waiting") return false;
  const startedAt = toTimestamp(order.startedAt || order.createdAt);
  const expiresAt = toTimestamp(order.expiresAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) return false;
  if (messageTime < startedAt - 1000 || messageTime > expiresAt) return false;
  if (order.deviceId && message.deviceId !== order.deviceId) return false;
  if (order.phoneNumber && message.phoneNumber && message.phoneNumber !== order.phoneNumber) return false;
  const messagePlatform = normalizedMessagePlatform(message);
  if (order.platform && order.platform !== messagePlatform) return false;
  return true;
}

function simMatchScore(order, message) {
  let score = 0;
  if (hasValue(order.subscriptionId) && hasValue(message.subscriptionId)) {
    if (Number(order.subscriptionId) !== Number(message.subscriptionId)) return -1;
    score += 2;
  }
  if (hasValue(order.slotIndex) && hasValue(message.slotIndex)) {
    if (Number(order.slotIndex) !== Number(message.slotIndex)) return -1;
    score += 1;
  }
  return score;
}

function newest(items) {
  return items.slice().sort((a, b) => (
    toTimestamp(b.startedAt || b.createdAt) - toTimestamp(a.startedAt || a.createdAt)
  ))[0] || null;
}

/**
 * Select one safe SMS order for an incoming message.
 *
 * Exact live SIM metadata wins. If the platform SIM metadata is stale, a
 * device-level fallback is allowed only when every candidate represents the
 * same logical request target. Two different SIM/phone targets on one device
 * are deliberately left unmatched rather than guessing a recipient.
 */
export function selectSmsOrderMatch(orders, message, messageTime) {
  if (!Number.isFinite(messageTime)) return null;
  const code = normalizedMessageCode(message);
  if (!code) return null;
  const baseCandidates = (Array.isArray(orders) ? orders : [])
    .filter((order) => isBaseCandidate(order, message || {}, messageTime));
  if (!baseCandidates.length) return null;

  const scored = baseCandidates
    .map((order) => ({ order, score: simMatchScore(order, message || {}) }))
    .filter((item) => item.score >= 0);
  const highestScore = scored.reduce((current, item) => Math.max(current, item.score), -1);
  if (highestScore > 0) {
    const best = scored.filter((item) => item.score === highestScore).map((item) => item.order);
    const targetKeys = new Set(best.map(logicalTargetKey));
    if (targetKeys.size === 1 || best.length === 1) {
      return { order: newest(best), strategy: "exact_sim", candidateCount: baseCandidates.length, code };
    }
    return null;
  }

  const targetKeys = new Set(baseCandidates.map(logicalTargetKey));
  if (targetKeys.size !== 1) return null;
  const selected = newest(baseCandidates);
  if (!selected) return null;
  const hadSimMismatch = baseCandidates.some((order) => simMatchScore(order, message || {}) < 0);
  return {
    order: selected,
    strategy: hadSimMismatch ? "unique_device_stale_sim" : "unique_device_unknown_sim",
    candidateCount: baseCandidates.length,
    code
  };
}
