const TERMINAL_AUTOMATION_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const TRANSIENT_LOOKUP_RESULT_STATUSES = new Set(["submitting", "queued", "running", "cancelling"]);

export function shouldIgnoreLateAutomationEvent(windowsTask = {}, automationJob = {}) {
  return TERMINAL_AUTOMATION_STATUSES.has(String(windowsTask.status || ""))
    || TERMINAL_AUTOMATION_STATUSES.has(String(automationJob.status || ""));
}

export function normalizeStoppedLookupResults(results = [], { updatedAt = new Date().toISOString() } = {}) {
  return (results || []).map((result) => TRANSIENT_LOOKUP_RESULT_STATUSES.has(String(result?.status || ""))
    ? {
        ...result,
        status: "cancelled",
        stage: "查询已取消",
        error: "会话已结束",
        updatedAt
      }
    : result);
}

export function shouldDrainPendingLookupQuery(job = {}) {
  return String(job?.kind || "") === "alipay_name_query"
    && ["submitting", "queued", "running"].includes(String(job?.status || ""));
}
