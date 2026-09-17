export function smsRefreshRatePolicy(source, options = {}) {
  const manual = new Set(["manual_user_request"]);
  return manual.has(String(source || ""))
    ? { scope: "manual", cooldownMs: Number(options.manualCooldownMs || 10_000) }
    : { scope: "auto", cooldownMs: Number(options.autoCooldownMs || 300_000) };
}
