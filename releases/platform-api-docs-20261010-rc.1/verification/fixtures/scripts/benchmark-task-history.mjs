// Local, synthetic-only benchmark. Does not import the server entrypoint, load
// .env/state, make connections or write files. Run: node scripts/benchmark-task-history.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import vm from "node:vm";
import { compactTaskPayload, maintainTaskHistory, normalizeLoadedTaskHistory } from "../server/task-history-maintenance.mjs";
import { createSmsMessageIndex } from "../server/sms-message-index.mjs";

const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const shape = [
  { collection: "windowsTasks", tasks: 4994, events: 24426, eventJsonChars: 53945117 },
  { collection: "xhsQrTasks", tasks: 490, events: 9642, eventJsonChars: 19935700 },
  { collection: "automationJobs", tasks: 3120, events: 18689, eventJsonChars: 48223178 }
];
const at = new Date().toISOString();
function fixture() {
  const state = Object.fromEntries(["smsOrders", "smsEvents", "smsMessages", "windowsTasks", "xhsQrTasks", "automationJobs", "automationSessions", "sessions", "audit", "deviceLocks", "evidenceAssets"].map(k => [k, []]));
  for (const s of shape) {
    const sample = { createdAt: at, message: "synthetic", detail: { syntheticPadding: "" } };
    const padding = "x".repeat(Math.max(0, Math.floor(s.eventJsonChars / s.events) - JSON.stringify(sample).length));
    const tasks = Array.from({ length: s.tasks }, () => ({ status: "succeeded", createdAt: at, updatedAt: at, events: [] }));
    for (let i = 0; i < s.events; i++) tasks[i % tasks.length].events.push({ ...sample, detail: { syntheticPadding: padding } });
    state[s.collection] = tasks;
  }
  state.smsMessages = Array.from({ length: 50_000 }, (_, i) => ({ deviceId: `synthetic-${i % 120}`, messageKey: `sms:${i}`, messageAt: at }));
  return state;
}
function runtime(state) {
  let rebuilds = 0;
  const index = createSmsMessageIndex(state.smsMessages);
  const context = vm.createContext({
    state, RETENTION_DAYS: 30, MAX_STORED_UI_SNAPSHOT_CHARS: 8000, MAX_STORED_UI_HIERARCHY_CHARS: 80000, MAX_PUBLISH_IMAGES: 9,
    ...Object.fromEntries(["SMS_ORDERS", "SMS_EVENTS", "SMS_MESSAGES", "WINDOWS_TASKS", "XHS_TASKS", "AUTOMATION_JOBS", "AUTOMATION_SESSIONS", "SESSIONS", "AUDIT_EVENTS", "EVIDENCE_ASSETS"].map(k => [`MAX_${k}`, 50_000])),
    compactTaskPayload, maintainTaskHistory, signedEvidenceUrl: () => "/synthetic",
    isActiveAutomationStatus: s => ["queued", "running", "stalled"].includes(s),
    expireDeviceLocks() {}, queueEvidenceCleanup() {},
    smsMessageIndex: { replace: rows => { rebuilds++; index.replace(rows); } }
  });
  const names = ["pruneState", "pruneArray", "stateCounts", "toTime", "trimTaskEvents", "compactTaskCollectionsForSave", "sanitizeStoredEvent", "sanitizeEventDetail", "sanitizeTaskResult", "sanitizeScreenshot", "sanitizeRunnerLogItem", "publicEvidenceAsset", "cloneJson", "isTerminalStatus"];
  vm.runInContext(names.map(extract).join("\n"), context);
  return { context, rebuildCount: () => rebuilds };
}
const candidateState = fixture();
const legacyState = fixture();
const candidate = runtime(candidateState);
const legacy = runtime(legacyState);
// Reproduce the verified old double-pass history work using the SAME current
// sanitizers/fixture on both sides. This is a controlled local algorithm
// comparison, NOT the entire production callback or an exact live-state replay.
function legacyHistory() {
  for (const s of shape) for (const task of legacyState[s.collection]) {
    if (legacy.context.isTerminalStatus(task.status)) {
      compactTaskPayload(task);
      if (task.result) task.result = legacy.context.sanitizeTaskResult(task.result, { includeEvidence: true });
      if (Array.isArray(task.events)) task.events = task.events.map(legacy.context.sanitizeStoredEvent);
    }
    if (!Array.isArray(task.events)) continue;
    task.events = task.events.map(legacy.context.sanitizeStoredEvent);
    if (task.events.length > 100) task.events = task.events.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100).reverse();
  }
}
const round = n => Math.round(n * 100) / 100;
let yields = 0;
let sliceAt = performance.now();
let maxSliceMs = 0;
const initializationAt = sliceAt;
await normalizeLoadedTaskHistory(shape.map(s => candidateState[s.collection]), {
  sanitizeEvent: candidate.context.sanitizeStoredEvent, sanitizeResult: candidate.context.sanitizeTaskResult,
  yieldTurn: async () => {
    maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceAt);
    yields++;
    await yieldTurn();
    sliceAt = performance.now();
  }
});
maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceAt);
const initialization = { wallMs: round(performance.now() - initializationAt), yields, maxObservedWorkSliceMs: round(maxSliceMs) };
async function measure(label, fn) {
  await yieldTurn();
  const scheduled = performance.now();
  let fired;
  const timer = new Promise(resolve => setTimeout(() => { fired = performance.now(); resolve(); }, 10));
  const started = performance.now();
  fn();
  const workMs = performance.now() - started;
  await timer;
  return { label, workMs: round(workMs), timerLatenessMs: round(Math.max(0, fired - scheduled - 10)) };
}
const rounds = [];
for (let i = 0; i < 5; i++) {
  rounds.push(await measure("legacy_double_pass_history", legacyHistory));
  rounds.push(await measure("candidate_history_only", () => { for (const s of shape) maintainTaskHistory(candidateState[s.collection]); }));
  rounds.push(await measure("candidate_actual_prune_with_50000_sms", () => candidate.context.pruneState()));
}
assert.equal(candidate.rebuildCount(), 0);
assert.equal(shape.reduce((n, s) => n + candidateState[s.collection].reduce((a, t) => a + t.events.length, 0), 0), 52757);
console.log(JSON.stringify({
  recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  indexSha256: crypto.createHash("sha256").update(source).digest("hex"),
  fixture: "Synthetic aggregate scale only; no production contents. SMS=50000; other non-task collections empty. Not a production latency promise.",
  scope: "History old/new comparison uses identical current sanitizers. Actual prune includes retention metadata and history, with no-op lock expiry/evidence deletion; excludes full snapshot serialization and other maintenance callbacks.",
  shape, initialization, candidateSmsIndexRebuilds: candidate.rebuildCount(), rounds
}, null, 2));
