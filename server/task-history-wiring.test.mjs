import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { compactTaskPayload, maintainTaskHistory } from "./task-history-maintenance.mjs";
import { createSmsMessageIndex } from "./sms-message-index.mjs";
import { createEvidenceSignedUrl, verifyEvidenceSignedUrl } from "./evidence-signing.mjs";
import { publicAutomationJob as buildPublicAutomationJob } from "./automation-center.mjs";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const maintenance = ["pruneState", "pruneArray", "stateCounts", "toTime", "trimTaskEvents", "compactTaskCollectionsForSave"];
const evidence = ["sanitizeStoredEvent", "cloneJson", "sanitizeEventDetail", "sanitizeTaskResult", "sanitizeScreenshot", "sanitizeRunnerLogItem", "publicEvidenceAsset", "signedEvidenceUrl", "publicEventHierarchyUrl", "publicXhsEventSummary", "publicWindowsTaskEventSummary", "publicAutomationJob", "isTerminalStatus"];
function runtime() {
  const state = Object.fromEntries(["smsOrders", "smsEvents", "smsMessages", "windowsTasks", "xhsQrTasks", "automationJobs", "automationSessions", "sessions", "audit", "deviceLocks", "evidenceAssets"].map(k => [k, []]));
  const index = createSmsMessageIndex();
  const calls = { replace: 0, expires: 0, cleanup: [] };
  const ctx = vm.createContext({
    state, RETENTION_DAYS: 30,
    ...Object.fromEntries(["SMS_ORDERS", "SMS_EVENTS", "SMS_MESSAGES", "WINDOWS_TASKS", "XHS_TASKS", "AUTOMATION_JOBS", "AUTOMATION_SESSIONS", "SESSIONS", "AUDIT_EVENTS", "EVIDENCE_ASSETS"].map(k => [`MAX_${k}`, 100])),
    compactTaskPayload, maintainTaskHistory,
    isActiveAutomationStatus: s => ["queued", "running", "stalled"].includes(s),
    expireDeviceLocks: () => { calls.expires++; },
    queueEvidenceCleanup: paths => calls.cleanup.push(...paths),
    smsMessageIndex: { replace: messages => { calls.replace++; index.replace(messages); } }
  });
  vm.runInContext(maintenance.map(extract).join("\n"), ctx);
  return { ctx, state, index, calls };
}

test("real pruneState preserves unchanged SMS index and historical event/result identities", () => {
  const { ctx, state, calls } = runtime();
  const at = new Date().toISOString();
  const event = { detail: { toJSON: () => assert.fail("no history serialization during prune/save") } };
  const task = { status: "succeeded", updatedAt: at, events: [event], result: event };
  state.windowsTasks.push(task);
  state.smsMessages.push({ messageAt: at, deviceId: "synthetic", messageKey: "sms:1" });
  const sms = state.smsMessages;
  const events = task.events;
  for (let i = 0; i < 10; i++) { ctx.pruneState(); ctx.compactTaskCollectionsForSave(); }
  assert.equal(calls.replace, 0);
  assert.equal(calls.expires, 10);
  assert.equal(state.smsMessages, sms);
  assert.equal(task.events, events);
  assert.equal(task.result, event);
});

test("real retention pruning rebuilds SMS index exactly when rows are removed", () => {
  const { ctx, state, calls, index } = runtime();
  const recent = { messageAt: new Date().toISOString(), deviceId: "synthetic", messageKey: "sms:new" };
  const old = { messageAt: "2000-01-01T00:00:00Z", deviceId: "synthetic", messageKey: "sms:old" };
  state.smsMessages.push(recent, old);
  state.evidenceAssets.push({ evidenceId: "expired", createdAt: old.messageAt, filePath: "/synthetic-only/old" });
  const result = ctx.pruneState();
  assert.equal(result.removed.smsMessages, 1);
  assert.equal(calls.replace, 1);
  assert.equal(index.countForDevice("synthetic"), 1);
  assert.equal(index.find("synthetic", "sms:new"), recent);
  assert.equal(index.find("synthetic", "sms:old"), null);
  assert.deepEqual(calls.cleanup, ["/synthetic-only/old"]);
  ctx.pruneState();
  assert.equal(calls.replace, 1);
});

test("manual dry-run does not compact payloads, trim events or replace SMS collections", () => {
  const { ctx, state, calls } = runtime();
  const at = new Date().toISOString();
  const task = { status: "succeeded", updatedAt: at, qrImageDataUrl: "synthetic-input", events: Array.from({ length: 101 }, () => ({ createdAt: at })) };
  state.windowsTasks.push(task);
  state.smsMessages.push({ messageAt: "2000-01-01T00:00:00Z" });
  assert.equal(ctx.pruneState({ dryRun: true }).removed.smsMessages, 1);
  assert.equal(state.smsMessages.length, 1);
  assert.equal(task.events.length, 101);
  assert.equal(task.qrImageDataUrl, "synthetic-input");
  assert.equal(calls.replace, 0);
});

test("retention caps never remove active tasks, including tasks beyond the configured cap", () => {
  const { ctx, state } = runtime();
  state.windowsTasks = Array.from({ length: 110 }, (_, i) => ({ taskId: i, status: "running", createdAt: "2000-01-01T00:00:00Z" }));
  state.windowsTasks.push({ status: "succeeded", createdAt: new Date().toISOString() });
  ctx.pruneState();
  assert.equal(state.windowsTasks.length, 110);
  assert.ok(state.windowsTasks.every(task => task.status === "running"));
});

test("stored evidence links refresh on serialization without periodic task mutation", () => {
  let now = Date.now();
  const secret = "synthetic-evidence-test-secret";
  const ctx = vm.createContext({
    MAX_STORED_UI_SNAPSHOT_CHARS: 8000, MAX_STORED_UI_HIERARCHY_CHARS: 80000, MAX_PUBLISH_IMAGES: 9,
    EVIDENCE_SIGNING_SECRET: secret, EVIDENCE_URL_TTL_SECONDS: 10,
    createEvidenceSignedUrl: (id, options) => createEvidenceSignedUrl(id, { ...options, nowMs: now }),
    buildPublicAutomationJob
  });
  vm.runInContext(evidence.map(extract).join("\n"), ctx);
  const event = ctx.sanitizeStoredEvent({
    screenshot: { evidenceId: "synthetic-png" }, uiHierarchyEvidence: { evidenceId: "synthetic-xml" },
    uiHierarchyUrl: "/stale", detail: { uiHierarchyEvidence: { evidenceId: "synthetic-detail" }, uiHierarchyUrl: "/stale" }
  });
  const storedUrl = event.uiHierarchyUrl;
  now += 11_000;
  function valid(url) {
    const u = new URL(url, "http://localhost");
    assert(verifyEvidenceSignedUrl(decodeURIComponent(u.pathname.split("/").at(-1)), { secret, expires: u.searchParams.get("expires"), signature: u.searchParams.get("sig"), nowMs: now }));
  }
  for (const fn of [ctx.publicWindowsTaskEventSummary, ctx.publicXhsEventSummary, ctx.sanitizeStoredEvent]) {
    const view = fn(event, { includeEvidence: true, includeScreenshot: true });
    valid(view.uiHierarchyUrl); valid(view.screenshot.url);
  }
  const result = ctx.sanitizeTaskResult({ uiHierarchyEvidence: event.uiHierarchyEvidence, uiHierarchyUrl: storedUrl, uiSnapshotEvidence: { evidenceId: "synthetic-snapshot" }, uiSnapshotUrl: "/stale" });
  valid(result.uiHierarchyUrl); valid(result.uiSnapshotUrl);
  const job = ctx.publicAutomationJob({ status: "failed", result, events: [event] });
  valid(job.events[0].detail.uiHierarchyUrl);
  const activeResult = { customProgress: "preserved" };
  assert.equal(ctx.publicAutomationJob({ status: "running", result: activeResult }).result, activeResult);
  assert.equal(event.uiHierarchyUrl, storedUrl, "stored data is not refreshed in place");
});

test("legacy normalization is before listen; 10-second expiry and persistence gates remain", () => {
  const normalize = source.indexOf("await normalizeLoadedTaskHistory(");
  assert(normalize > source.indexOf("applyStructuredOverlay(state,"));
  assert(normalize < source.indexOf("const maintenanceTimer = setInterval"));
  assert(normalize < source.indexOf("const server = http.createServer"));
  const timer = source.slice(source.indexOf("const maintenanceTimer = setInterval"), source.indexOf("const server = http.createServer"));
  for (const name of ["expireSmsOrders", "recoverStalledTasks", "expireWindowsTasks", "expireXhsTasks", "expireDeviceLocks", "revokeExpiredSessions"]) assert(timer.includes(`${name}()`));
  assert.match(timer, /10_000/);
  assert.doesNotMatch(extract("trimTaskEvents"), /sanitize|compactCompletedTask/);
  assert.doesNotMatch(extract("compactTaskCollectionsForSave"), /sanitize|compactCompletedTask/);
});
