// Account labels are only unique inside one verified device's account picker.
// Do not merge masked labels across phones, users or application slots.
export const LOOKUP_ACCOUNT_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const LIMIT_REASONS = new Set(["access_denied", "device_risk", "frequent_or_abnormal_access"]);

export function accountLabel(value) {
  const label = String(value || "").trim();
  return label && label.length <= 120 && !/[\u0000-\u001f\u007f]/.test(label) ? label : "";
}

export function isVerifiedLookupAccountRestrictionEvent(event = {}) {
  const detail = event.detail || {};
  return ["alipay_access_denied_detected", "alipay_account_restriction_detected", "lookup_account_limit_confirmed"]
    .includes(String(event.stepId || detail.step || ""))
    && detail.accountIdentityVerified === true && Boolean(accountLabel(detail.currentAccount))
    && typeof detail.phoneQueryStarted === "boolean" && detail.accountSwitchRequired === true
    && LIMIT_REASONS.has(detail.reason);
}

export function recordLookupAccountCooldown(device, input = {}, now = Date.now()) {
  const account = accountLabel(input.account);
  if (!device || !account || !input.restrictionId || input.accountIdentityVerified !== true
      || typeof input.phoneQueryStarted !== "boolean"
      || !LIMIT_REASONS.has(input.reason)) return null;
  const detected = Date.parse(input.detectedAt);
  if (!Number.isFinite(detected) || detected > now || detected < 0) return null;
  const rows = device.lookupAccountCooldowns ||= [];
  const previous = rows.find((row) => row.account === account);
  // An event replay or the final result must not restart the eight-hour clock.
  if (previous?.restrictionId === input.restrictionId) return previous;
  if (previous && Date.parse(previous.limitedAt) >= detected) return previous;
  const record = {
    account, limitedAt: new Date(detected).toISOString(),
    cooldownUntil: new Date(detected + LOOKUP_ACCOUNT_COOLDOWN_MS).toISOString(),
    reason: input.reason, phoneQueryStarted: input.phoneQueryStarted,
    restrictionId: String(input.restrictionId), jobId: String(input.jobId || "")
  };
  if (previous) rows.splice(rows.indexOf(previous), 1, record);
  else rows.push(record);
  return record;
}

export function publicLookupAccountCooldowns(device, now = Date.now()) {
  return (Array.isArray(device?.lookupAccountCooldowns) ? device.lookupAccountCooldowns : [])
    .filter((row) => accountLabel(row.account) && Number.isFinite(Date.parse(row.cooldownUntil)))
    .map((row) => ({
      account: row.account, limitedAt: row.limitedAt, cooldownUntil: row.cooldownUntil,
      reason: row.reason, remainingMs: Math.max(0, Date.parse(row.cooldownUntil) - now),
      cooling: Date.parse(row.cooldownUntil) > now
    }));
}

export function lookupAccountPolicy(device, session = {}, now = Date.now()) {
  return {
    accountCooldownProtocol: 1,
    knownAccount: accountLabel(session.currentAccount),
    accountIdentityVerified: session.accountIdentityVerified === true,
    verifyAccountBeforeQuery: session.accountQueryStarted !== true,
    accountCooldowns: publicLookupAccountCooldowns(device, now)
  };
}

export function verifiedSavedAccounts(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12) return null;
  const rows = value.map((row) => ({ account: accountLabel(row?.account), current: row?.current === true }));
  if (rows.some((row) => !row.account) || rows.filter((row) => row.current).length !== 1
      || new Set(rows.map((row) => row.account)).size !== rows.length) return null;
  return rows;
}

export function allSavedAccountsCooling(device, savedAccounts, now = Date.now()) {
  const saved = verifiedSavedAccounts(savedAccounts);
  if (!saved) return false;
  const cooling = new Set(publicLookupAccountCooldowns(device, now).filter((row) => row.cooling).map((row) => row.account));
  return saved.every((row) => cooling.has(row.account));
}
