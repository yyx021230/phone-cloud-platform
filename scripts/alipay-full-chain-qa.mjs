const baseUrl = String(process.env.PHONE_CLOUD_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = String(process.env.ADMIN_API_TOKEN || "").trim();
const deviceNumber = String(process.argv[2] || "").trim();
const firstPhoneNumber = String(process.argv[3] || "").trim();
const secondPhoneNumber = String(process.argv[4] || process.argv[3] || "").trim();

if (!token) throw new Error("ADMIN_API_TOKEN missing");
if (!/^\d+$/.test(deviceNumber)) throw new Error("numeric device number required");
if (!/^\d{11}$/.test(firstPhoneNumber) || !/^\d{11}$/.test(secondPhoneNumber)) {
  throw new Error("two authorized 11-digit phone numbers required");
}

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json"
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${response.status}:${body.error || "request_failed"}`);
    error.body = body;
    throw error;
  }
  return body;
}

async function currentSession(sessionId) {
  const payload = await request("/api/v1/user/automation/alipay-name-sessions");
  return (payload.sessions || []).find((item) => item.sessionId === sessionId) || null;
}

async function waitForSession(sessionId, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let session = null;
  while (Date.now() - startedAt < timeoutMs) {
    session = await currentSession(sessionId);
    if (!session) throw new Error("session_disappeared");
    if (predicate(session)) return { session, durationMs: Date.now() - startedAt };
    await sleep(500);
  }
  const error = new Error(`${label}_timeout:${session?.status || "unknown"}`);
  error.session = session;
  throw error;
}

async function waitForQuery(sessionId, resultId, timeoutMs) {
  const terminal = new Set([
    "succeeded", "not_found", "limit_reached", "needs_human_verification", "failed", "cancelled"
  ]);
  const waited = await waitForSession(sessionId, (session) => {
    const result = (session.results || []).find((item) => item.resultId === resultId);
    return ["failed", "expired"].includes(session.status)
      || (!session.pendingJobId && result && terminal.has(String(result.status || "")));
  }, timeoutMs, "query");
  return {
    ...waited,
    result: (waited.session.results || []).find((item) => item.resultId === resultId) || null
  };
}

async function windowsTaskForJob(jobId) {
  const payload = await request("/api/v1/windows-agent-tasks?limit=300");
  return (payload.tasks || []).find((task) => task.payload?.automationJobId === jobId) || null;
}

async function stageEvidence(jobId) {
  const summary = await windowsTaskForJob(jobId);
  if (!summary) return {
    jobId, taskId: "", driver: "", resultMessage: "", resultError: "",
    restrictionReason: "", forbiddenXmlFallback: false, events: []
  };
  const [detail, eventPayload] = await Promise.all([
    request(`/api/v1/windows-agent-tasks/${encodeURIComponent(summary.taskId)}`),
    request(`/api/v1/windows-agent-tasks/${encodeURIComponent(summary.taskId)}/events`)
  ]);
  const events = (eventPayload.events || []).map((event) => String(event.message || event.stepId || ""));
  const joined = events.join("\n");
  const result = detail.task?.result || {};
  return {
    jobId,
    taskId: summary.taskId,
    driver: String(result.driver || ""),
    resultMessage: String(result.message || ""),
    resultError: String(result.errorCode || result.error || ""),
    restrictionReason: String(result.restrictionReason || result.diagnostic?.limitReason || ""),
    forbiddenXmlFallback: joined.includes("Poco 快路径异常，正在切换 XML 兜底")
      || String(result.driver || "") === "xml_uiautomator_fallback",
    events
  };
}

function preQueryCoverageLimit(session, evidence) {
  const combined = [
    session?.error,
    evidence?.resultMessage,
    evidence?.resultError,
    evidence?.restrictionReason,
    ...(evidence?.events || [])
  ].join("\n");
  if (evidence?.resultMessage === "search_session_restricted") {
    return evidence.restrictionReason || "restriction_before_search";
  }
  if (combined.includes("alipay_login_required")) return "login_required";
  if (combined.includes("jigsaw_verification")) return "jigsaw_verification_before_search";
  if (combined.includes("device_risk")) return "device_risk_before_search";
  if (combined.includes("frequent_or_abnormal_access")) return "frequent_or_abnormal_access_before_search";
  if (combined.includes("access_denied")) return "access_denied_before_search";
  return "";
}

function summarizeQuery(waited, evidence) {
  const result = waited.result || {};
  return {
    durationMs: waited.durationMs,
    resultStatus: String(result.status || ""),
    notFound: Boolean(result.notFound),
    limitReason: String(result.limitReason || ""),
    error: String(result.error || waited.session.error || ""),
    taskId: evidence.taskId,
    driver: evidence.driver,
    forbiddenXmlFallback: evidence.forbiddenXmlFallback
  };
}

function assertKnownQueryOutcome(summary, phase) {
  if (!["succeeded", "not_found", "limit_reached", "needs_human_verification"].includes(summary.resultStatus)) {
    throw new Error(`${phase}_unexpected_result:${summary.resultStatus || "missing"}`);
  }
}

async function queueQuery(sessionId, phoneNumber) {
  const queued = await request(
    `/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(sessionId)}/queries`,
    { method: "POST", body: JSON.stringify({ phoneNumber }) }
  );
  const jobId = String(queued.job?.jobId || "");
  const waited = await waitForQuery(sessionId, jobId, 100_000);
  const evidence = await stageEvidence(jobId);
  return { waited, evidence, summary: summarizeQuery(waited, evidence) };
}

const devicesPayload = await request("/api/v1/devices");
const matches = (devicesPayload.devices || []).filter(
  (item) => String(item.deviceName || "").trim() === deviceNumber
);
if (matches.length !== 1) throw new Error(`device_number_not_unique:${matches.length}`);
const device = matches[0];

const locksPayload = await request("/api/v1/device-locks");
const activeLock = (locksPayload.locks || []).find(
  (lock) => lock.status === "active" && lock.deviceId === device.deviceId
);
if (activeLock) throw new Error(`device_busy:${activeLock.lockType || "unknown"}`);

let sessionId = "";
let cleanup = null;
const report = {
  ok: false,
  deviceNumber,
  sessionId: "",
  start: null,
  firstQuery: null,
  accountList: null,
  accountSwitch: null,
  secondQuery: null,
  cleanup: null
};

try {
  const created = await request("/api/v1/user/automation/alipay-name-sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId: device.deviceId })
  });
  sessionId = created.session.sessionId;
  report.sessionId = sessionId;
  const startJobId = String(created.session.pendingJobId || "");
  const started = await waitForSession(
    sessionId,
    (session) => ["ready", "failed", "expired"].includes(session.status),
    100_000,
    "start"
  );
  const startEvidence = await stageEvidence(startJobId);
  report.start = {
    durationMs: started.durationMs,
    status: started.session.status,
    taskId: startEvidence.taskId,
    driver: startEvidence.driver,
    forbiddenXmlFallback: startEvidence.forbiddenXmlFallback
  };
  const coverageLimit = preQueryCoverageLimit(started.session, startEvidence);
  if (coverageLimit) {
    const error = new Error(`known_pre_query_limit:${coverageLimit}`);
    error.coverageLimited = coverageLimit;
    throw error;
  }
  if (started.session.status !== "ready") throw new Error(`start_${started.session.status}`);
  if (started.durationMs > 38_000) throw new Error(`start_slo_exceeded:${started.durationMs}`);
  if (startEvidence.forbiddenXmlFallback) throw new Error("start_forbidden_xml_fallback");

  const first = await queueQuery(sessionId, firstPhoneNumber);
  report.firstQuery = first.summary;
  if (first.waited.durationMs > 18_000) throw new Error(`first_query_slo_exceeded:${first.waited.durationMs}`);
  if (first.evidence.forbiddenXmlFallback) throw new Error("first_query_forbidden_xml_fallback");
  assertKnownQueryOutcome(first.summary, "first_query");

  const listed = await request(
    `/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(sessionId)}/switch-account`,
    { method: "POST", body: "{}" }
  );
  const listJobId = String(listed.job?.jobId || "");
  const listWait = await waitForSession(
    sessionId,
    (session) => !session.pendingJobId
      && ["choosing_account", "ready", "failed", "expired"].includes(session.status),
    100_000,
    "account_list"
  );
  const listEvidence = await stageEvidence(listJobId);
  const choices = Array.isArray(listWait.session.accountChoices) ? listWait.session.accountChoices : [];
  report.accountList = {
    durationMs: listWait.durationMs,
    status: listWait.session.status,
    taskId: listEvidence.taskId,
    driver: listEvidence.driver,
    accountCount: choices.length,
    currentAccount: String(listWait.session.currentAccount || "")
  };
  if (!["choosing_account", "ready"].includes(listWait.session.status)) {
    throw new Error(`account_list_${listWait.session.status}`);
  }

  const alternate = choices.find((choice) => !choice.current);
  if (!alternate) {
    report.ok = true;
    report.coverageLimited = "no_alternate_saved_account";
  } else {
    const switched = await request(
      `/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(sessionId)}/switch-account`,
      { method: "POST", body: JSON.stringify({ targetAccount: alternate.account }) }
    );
    const switchJobId = String(switched.job?.jobId || "");
    const switchWait = await waitForSession(
      sessionId,
      (session) => !session.pendingJobId && ["ready", "failed", "expired"].includes(session.status),
      100_000,
      "account_switch"
    );
    const switchEvidence = await stageEvidence(switchJobId);
    report.accountSwitch = {
      durationMs: switchWait.durationMs,
      status: switchWait.session.status,
      taskId: switchEvidence.taskId,
      driver: switchEvidence.driver,
      fromAccount: String(switchWait.session.lastAccountSwitch?.fromAccount || ""),
      toAccount: String(switchWait.session.lastAccountSwitch?.toAccount || "")
    };
    if (switchWait.session.status !== "ready") throw new Error(`account_switch_${switchWait.session.status}`);

    const second = await queueQuery(sessionId, secondPhoneNumber);
    report.secondQuery = second.summary;
    if (second.waited.durationMs > 18_000) throw new Error(`second_query_slo_exceeded:${second.waited.durationMs}`);
    if (second.evidence.forbiddenXmlFallback) throw new Error("second_query_forbidden_xml_fallback");
    assertKnownQueryOutcome(second.summary, "second_query");
    report.ok = true;
  }
} catch (error) {
  if (error.coverageLimited) {
    report.ok = true;
    report.coverageLimited = error.coverageLimited;
  } else {
    report.error = error.message;
    report.code = String(error.body?.error || "");
    process.exitCode = 1;
  }
} finally {
  if (sessionId) {
    try {
      const session = await currentSession(sessionId);
      if (session && !["ended", "failed", "expired"].includes(session.status)) {
        const ended = await request(
          `/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(sessionId)}/end`,
          { method: "POST", body: "{}" }
        );
        const stopJobId = String(ended.session?.pendingJobId || "");
        const stopped = await waitForSession(
          sessionId,
          (item) => ["ended", "failed", "expired"].includes(item.status),
          45_000,
          "stop"
        );
        const stopEvidence = await stageEvidence(stopJobId);
        cleanup = {
          durationMs: stopped.durationMs,
          status: stopped.session.status,
          taskId: stopEvidence.taskId,
          driver: stopEvidence.driver,
          forbiddenXmlFallback: stopEvidence.forbiddenXmlFallback
        };
        if (stopEvidence.forbiddenXmlFallback) process.exitCode = 1;
      } else {
        cleanup = { durationMs: 0, status: session?.status || "missing", taskId: "", driver: "" };
      }
    } catch (error) {
      cleanup = { status: "cleanup_failed", error: error.message };
      process.exitCode = 1;
    }
  }
  report.cleanup = cleanup;
  console.log(JSON.stringify(report));
}
