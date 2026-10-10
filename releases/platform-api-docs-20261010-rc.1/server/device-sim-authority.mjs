const REPORTED_SOURCES = new Set(["adb", "phone_agent"]);

export function normalizeSimPhoneSource(value = "") {
  const source = String(value || "").trim().toLowerCase();
  if (source === "admin") return "admin";
  return REPORTED_SOURCES.has(source) ? source : "";
}

export function applyAdminSimAuthority(sims = [], updatedAt = new Date().toISOString()) {
  return (Array.isArray(sims) ? sims : []).map((sim) => ({
    ...sim,
    phoneNumberSource: "admin",
    phoneNumberUpdatedAt: updatedAt
  }));
}

export function mergeReportedSims(existingSims = [], reportedSims = [], options = {}) {
  const reportedSource = REPORTED_SOURCES.has(options.source) ? options.source : "adb";
  const updatedAt = String(options.updatedAt || new Date().toISOString());
  const existingBySlot = new Map((Array.isArray(existingSims) ? existingSims : []).map((sim, index) => [
    String(sim.slotIndex ?? index),
    sim
  ]));

  const merged = (Array.isArray(reportedSims) ? reportedSims : []).map((reported, index) => {
    const slotKey = String(reported.slotIndex ?? index);
    const existing = existingBySlot.get(slotKey) || {};
    existingBySlot.delete(slotKey);

    const existingNumber = String(existing.phoneNumber || "");
    const reportedNumber = String(reported.phoneNumber || "");
    const existingSource = normalizeSimPhoneSource(existing.phoneNumberSource);
    const preserveExistingNumber = existingSource === "admin" || Boolean(existingNumber);
    const phoneNumber = preserveExistingNumber ? existingNumber : reportedNumber;
    const phoneNumberSource = preserveExistingNumber
      ? (existingSource || "admin")
      : (reportedNumber ? reportedSource : existingSource);
    const phoneNumberUpdatedAt = preserveExistingNumber
      ? (String(existing.phoneNumberUpdatedAt || "") || updatedAt)
      : (reportedNumber ? updatedAt : String(existing.phoneNumberUpdatedAt || ""));

    return {
      ...existing,
      ...reported,
      phoneNumber,
      phoneNumberSource,
      phoneNumberUpdatedAt,
      enabled: existing.enabled === false ? false : reported.enabled !== false
    };
  });

  for (const sim of existingBySlot.values()) {
    if (sim.phoneNumber || normalizeSimPhoneSource(sim.phoneNumberSource) === "admin") merged.push(sim);
  }

  return merged
    .sort((a, b) => Number(a.slotIndex) - Number(b.slotIndex))
    .slice(0, 4);
}
