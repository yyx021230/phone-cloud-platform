const ACTIVE_STATUSES = new Set(["queued", "running", "stalled"]);

export function isActiveAutomationStatus(status) {
  return ACTIVE_STATUSES.has(String(status || ""));
}

export function normalizeAutomationKind(kind) {
  const value = String(kind || "").trim();
  if (["xhs_publish", "alipay_name_start", "alipay_name_query", "alipay_name_stop"].includes(value)) return value;
  throw new TypeError("unsupported_automation_kind");
}

export function normalizeLookupPhone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (!/^1\d{10}$/.test(phone)) throw new TypeError("invalid_phone_number");
  return phone;
}

export function automationLockType(kind) {
  return String(kind || "").startsWith("alipay_name_") ? "alipay_name_lookup" : "xhs_publish";
}

export function publicAutomationJob(job = {}) {
  return {
    jobId: String(job.jobId || ""),
    kind: String(job.kind || ""),
    sessionId: String(job.sessionId || ""),
    deviceId: String(job.deviceId || ""),
    xhsAppSlot: String(job.xhsAppSlot || ""),
    xhsAccountLabel: String(job.xhsAccountLabel || ""),
    title: String(job.title || ""),
    content: String(job.content || ""),
    phoneNumber: String(job.phoneNumber || ""),
    status: String(job.status || "queued"),
    result: job.result && typeof job.result === "object" ? job.result : {},
    events: Array.isArray(job.events) ? job.events.slice(-30) : [],
    cancellable: isActiveAutomationStatus(job.status),
    createdAt: String(job.createdAt || ""),
    updatedAt: String(job.updatedAt || ""),
    pickedAt: job.pickedAt || null,
    completedAt: job.completedAt || null
  };
}

export function publicLookupSession(session = {}) {
  return {
    sessionId: String(session.sessionId || ""),
    deviceId: String(session.deviceId || ""),
    status: String(session.status || "starting"),
    successfulCount: Math.max(0, Number(session.successfulCount || 0)),
    switchEvery: Math.max(1, Number(session.switchEvery || 200)),
    currentAccount: String(session.currentAccount || ""),
    pendingJobId: String(session.pendingJobId || ""),
    results: Array.isArray(session.results) ? session.results.slice(0, 500) : [],
    error: String(session.error || ""),
    createdAt: String(session.createdAt || ""),
    updatedAt: String(session.updatedAt || ""),
    endedAt: session.endedAt || null
  };
}
