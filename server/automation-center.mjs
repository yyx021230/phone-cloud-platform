const ACTIVE_STATUSES = new Set(["queued", "running", "stalled"]);
const LOOKUP_RESTRICTION_REASONS = new Set([
  "access_denied",
  "jigsaw_verification",
  "device_risk",
  "frequent_or_abnormal_access"
]);

export function isActiveAutomationStatus(status) {
  return ACTIVE_STATUSES.has(String(status || ""));
}

export function normalizeAutomationKind(kind) {
  const value = String(kind || "").trim();
  if (["xhs_publish", "xhs_data_collect", "kuaishou_lead", "alipay_name_start", "alipay_name_query", "alipay_name_switch", "alipay_name_stop"].includes(value)) return value;
  throw new TypeError("unsupported_automation_kind");
}

export function normalizeKuaishouLeadDelayRange(minimum, maximum) {
  const minDelaySeconds = minimum === undefined || minimum === null || minimum === "" ? 240 : Number(minimum);
  const maxDelaySeconds = maximum === undefined || maximum === null || maximum === "" ? 420 : Number(maximum);
  if (!Number.isInteger(minDelaySeconds) || !Number.isInteger(maxDelaySeconds)
    || minDelaySeconds < 30 || maxDelaySeconds > 3600 || maxDelaySeconds < minDelaySeconds) {
    throw new TypeError("invalid_kuaishou_lead_delay_range");
  }
  return { minDelaySeconds, maxDelaySeconds };
}

export function normalizeLookupPhone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (!/^1\d{10}$/.test(phone)) throw new TypeError("invalid_phone_number");
  return phone;
}

export function normalizeLookupAccountChoice(value) {
  const account = String(value || "").trim();
  if (!account || account.length > 120 || /[\u0000-\u001f\u007f]/.test(account)) {
    throw new TypeError("invalid_lookup_account_choice");
  }
  return account;
}

export function resumableLookupHumanVerificationResult(session = {}) {
  if (session.pendingJobId) return null;
  if (!["ready", "needs_human_verification"].includes(String(session.status || ""))) return null;
  const latestResult = Array.isArray(session.results)
    ? session.results.find((result) => result?.status !== "queued")
    : null;
  if (session.startupHumanVerification?.status === "needs_human_verification") return session.startupHumanVerification;
  if (!latestResult) return null;
  return latestResult.status === "needs_human_verification"
    || (latestResult.limitReason === "jigsaw_verification" && !["succeeded", "not_found", "cancelled"].includes(latestResult.status))
    ? latestResult
    : null;
}

// The Agent has already tried page recovery and reported a terminal failure.
// Match only this bounded diagnostic, not arbitrary worker/transport errors.
export function lookupPageRecoveryExhausted(job = {}) {
  return job.kind === "alipay_name_query"
    && job.result?.errorCode === "alipay_lookup_failed"
    && /^poco_query_page_recovery_failed:/.test(String(job.result?.diagnostic?.runnerReason || ""));
}

export function lookupHumanRecoveryUnresolved(job = {}, status = "", options = {}) {
  return Boolean(
    status === "failed"
    && options.limitReached !== true
    && (job.resumeAfterHumanVerification === true
      || lookupPageRecoveryExhausted(job)
      || job.kind === "alipay_name_query" && (
        job.result?.errorCode === "alipay_lookup_result_unconfirmed"
        || /^local_lookup_result_unconfirmed:/.test(String(job.result?.diagnostic?.runnerReason || ""))
      ))
  );
}

export function resumableLookupRecoveryResult(session = {}) {
  if (session.pendingJobId || session.status !== "ready") return null;
  if (session.startupHumanVerification?.status === "needs_recovery") return session.startupHumanVerification;
  const result = session.results?.find((item) => item?.status !== "queued");
  return result?.status === "needs_recovery" ? result : null;
}

export function hasVerifiedAllSavedAccountsRestricted(diagnostic = {}) {
  if (String(diagnostic.code || "") !== "alipay_all_saved_accounts_restricted") return false;
  const savedAccountCount = Math.max(0, Number(diagnostic.savedAccountCount || 0));
  const restrictedAccounts = [...new Set((Array.isArray(diagnostic.restrictedAccounts)
    ? diagnostic.restrictedAccounts
    : []).map((account) => String(account || "").trim()).filter(Boolean))];
  const accountSwitchCount = Math.max(0, Number(diagnostic.accountSwitchCount || 0));
  const accountSwitchHistory = Array.isArray(diagnostic.accountSwitchHistory)
    ? diagnostic.accountSwitchHistory
    : [];
  return savedAccountCount > 0
    && restrictedAccounts.length === savedAccountCount
    && accountSwitchCount >= Math.max(0, savedAccountCount - 1)
    && accountSwitchHistory.length >= Math.max(0, savedAccountCount - 1);
}

export function automationLockType(kind) {
  if (String(kind || "") === "kuaishou_lead") return "kuaishou_lead";
  if (kind === "xhs_data_collect") return "xhs_data_collect";
  return String(kind || "").startsWith("alipay_name_") ? "alipay_name_lookup" : "xhs_publish";
}

export function isPostQueryLookupRestrictionEvent(event = {}) {
  const step = String(event.stepId || event.detail?.step || "");
  const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
  const reason = String(detail.reason || "");
  return ["alipay_access_denied_detected", "alipay_account_restriction_detected", "lookup_account_limit_confirmed"].includes(step)
    && detail.phoneQueryStarted === true
    && detail.accountSwitchRequired === true
    && LOOKUP_RESTRICTION_REASONS.has(reason);
}

export function upsertLookupRestrictionHistory(session, input = {}) {
  if (!session || !input.jobId) return null;
  const reason = LOOKUP_RESTRICTION_REASONS.has(String(input.reason || "")) ? String(input.reason) : "";
  if (!reason) return null;
  const record = {
    restrictionId: String(input.restrictionId || input.jobId).slice(0, 120),
    jobId: String(input.jobId || "").slice(0, 120),
    windowsTaskId: String(input.windowsTaskId || "").slice(0, 120),
    deviceId: String(input.deviceId || session.deviceId || "").slice(0, 200),
    phoneNumber: String(input.phoneNumber || "").replace(/\D/g, "").slice(0, 20),
    account: String(input.account || "").slice(0, 120),
    reason,
    title: String(input.title || "").slice(0, 200),
    driver: String(input.driver || "").slice(0, 80),
    phase: String(input.phase || "").slice(0, 120),
    phoneQueryStarted: input.phoneQueryStarted === true,
    requiresAccountSwitch: input.requiresAccountSwitch !== false,
    status: input.status === "confirmed" ? "confirmed" : "detected",
    errorCode: String(input.errorCode || "").slice(0, 160),
    message: String(input.message || "").slice(0, 500),
    detectedAt: String(input.detectedAt || "").slice(0, 80),
    confirmedAt: String(input.confirmedAt || "").slice(0, 80)
  };
  if (!Array.isArray(session.restrictionHistory)) session.restrictionHistory = [];
  const existingIndex = session.restrictionHistory.findIndex((item) => item.restrictionId === record.restrictionId);
  if (existingIndex >= 0) {
    const existing = session.restrictionHistory[existingIndex];
    session.restrictionHistory.splice(existingIndex, 1);
    session.restrictionHistory.unshift(Object.fromEntries(
      Object.entries({ ...existing, ...record }).map(([key, value]) => [key, value === "" ? existing[key] || "" : value])
    ));
  } else {
    session.restrictionHistory.unshift(record);
  }
  session.restrictionHistory = session.restrictionHistory.slice(0, 100);
  return session.restrictionHistory[0];
}

export function publicAutomationJob(job = {}) {
  return {
    jobId: String(job.jobId || ""),
    kind: String(job.kind || ""),
    sessionId: String(job.sessionId || ""),
    deviceId: String(job.deviceId || ""),
    xhsAppSlot: String(job.xhsAppSlot || ""),
    xhsAccountLabel: String(job.xhsAccountLabel || ""),
    ...(job.kind === "xhs_data_collect" ? {
      xhsAccountId: String(job.xhsAccountId || ""),
      xhsAccountName: String(job.xhsAccountName || ""),
      clientRequestId: String(job.clientRequestId || ""),
      accountIdentitySource: "platform_binding_snapshot"
    } : {}),
    title: String(job.title || ""),
    content: String(job.content || ""),
    phoneNumber: String(job.phoneNumber || ""),
    minDelaySeconds: Math.max(0, Number(job.minDelaySeconds || 0)),
    maxDelaySeconds: Math.max(0, Number(job.maxDelaySeconds || 0)),
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
  const accountChoices = Array.isArray(session.accountChoices)
    ? session.accountChoices.slice(0, 12).map((choice) => ({
      account: String(choice?.account || "").slice(0, 120),
      current: Boolean(choice?.current)
    })).filter((choice) => choice.account)
    : [];
  return {
    sessionId: String(session.sessionId || ""),
    deviceId: String(session.deviceId || ""),
    status: String(session.status || "starting"),
    successfulCount: Math.max(0, Number(session.successfulCount || 0)),
    currentAccount: String(session.currentAccount || ""),
    requiresAccountSwitch: Boolean(session.requiresAccountSwitch),
    limitReason: String(session.limitReason || ""),
    lastAccountSwitch: session.lastAccountSwitch && typeof session.lastAccountSwitch === "object" ? {
      fromAccount: String(session.lastAccountSwitch.fromAccount || "").slice(0, 120),
      toAccount: String(session.lastAccountSwitch.toAccount || "").slice(0, 120),
      switchedAt: String(session.lastAccountSwitch.switchedAt || "")
    } : null,
    accountChoices,
    restrictionHistory: Array.isArray(session.restrictionHistory)
      ? session.restrictionHistory.slice(0, 50).map((item) => ({
        restrictionId: String(item?.restrictionId || "").slice(0, 120),
        jobId: String(item?.jobId || "").slice(0, 120),
        windowsTaskId: String(item?.windowsTaskId || "").slice(0, 120),
        deviceId: String(item?.deviceId || "").slice(0, 200),
        phoneNumber: String(item?.phoneNumber || "").replace(/\D/g, "").slice(0, 20),
        account: String(item?.account || "").slice(0, 120),
        reason: String(item?.reason || "").slice(0, 80),
        title: String(item?.title || "").slice(0, 200),
        driver: String(item?.driver || "").slice(0, 80),
        phase: String(item?.phase || "").slice(0, 120),
        phoneQueryStarted: Boolean(item?.phoneQueryStarted),
        requiresAccountSwitch: Boolean(item?.requiresAccountSwitch),
        status: String(item?.status || "detected").slice(0, 40),
        errorCode: String(item?.errorCode || "").slice(0, 160),
        message: String(item?.message || "").slice(0, 500),
        detectedAt: String(item?.detectedAt || "").slice(0, 80),
        confirmedAt: String(item?.confirmedAt || "").slice(0, 80)
      }))
      : [],
    pendingJobId: String(session.pendingJobId || ""),
    startupHumanVerification: session.startupHumanVerification || null,
    results: Array.isArray(session.results) ? session.results.slice(0, 500) : [],
    error: String(session.error || ""),
    createdAt: String(session.createdAt || ""),
    updatedAt: String(session.updatedAt || ""),
    endedAt: session.endedAt || null
  };
}
