import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { publicLookupSession, resumableLookupHumanVerificationResult, resumableLookupRecoveryResult } from "./automation-center.mjs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `source section exists: ${start}`);
  return source.slice(first, last);
}

function blockedSession(overrides = {}) {
  return {
    sessionId: "session-synthetic", deviceId: "device-synthetic", userId: "user-synthetic",
    status: "ready", pendingJobId: "",
    results: [{ resultId: "query-original", phoneNumber: "13800000000", status: "needs_human_verification", limitReason: "jigsaw_verification" }],
    ...overrides
  };
}

function browserHarness(session = blockedSession()) {
  const alerts = [];
  const timers = [];
  const actions = [];
  const device = { deviceId: session.deviceId, deviceName: "测试手机" };
  const state = {
    token: "synthetic-session", page: "user-workbench", userWorkbenchView: "detail",
    userSelectedDeviceId: device.deviceId, userLookupSessions: [session],
    userScreenStatus: "idle", userScreenDeviceId: "", userLookupBusy: false, userLookupEnding: false
  };
  const els = Object.fromEntries([
    "userLookupPhoneInput", "userLookupQueryButton", "userLookupSwitchButton",
    "userLookupHumanResumePanel", "userLookupHumanResumeButton", "userLookupRecoveryRetryButton", "userLookupHint", "userLookupEndButton"
  ].map((name) => [name, { disabled: false, hidden: false, value: "13800000001" }]));
  els.userLookupSessionStatus = { dataset: {} };
  const context = vm.createContext({
    state, els, Date, alert: (message) => alerts.push(message), setTimeout: (fn) => timers.push(fn),
    activeLookupSessionForDevice: (id) => state.userLookupSessions.find((item) => item.deviceId === id),
    api: async (...args) => { actions.push(args); throw new Error("no API action expected"); },
    formatDurationMs: () => "0 秒", escapeHtml: String
  });
  vm.runInContext([
    section(app, "function resumableLookupHumanVerificationResult(session)", "async function submitLookupAccountAction"),
    section(app, "function renderLookupSession(session, device)", "function renderUserScreenControl"),
    section(app, "async function submitLookupQuery()", "els.userLookupQueryButton?.addEventListener"),
    section(app, "async function submitLookupAccountAction", "els.userLookupSwitchButton?.addEventListener")
  ].join("\n"), context);
  return {
    state, els, alerts, actions, context, device,
    notify: () => context.notifyLookupHumanVerification(state.userLookupSessions[0], device),
    render: () => context.renderLookupSession(state.userLookupSessions[0], device),
    flush: () => { for (const fn of timers.splice(0)) fn(); }
  };
}

test("jigsaw prompts once during repeated polling and performs no device or API action", () => {
  const h = browserHarness();
  const before = JSON.stringify(h.state.userLookupSessions);
  for (let i = 0; i < 100; i++) { h.notify(); h.flush(); }
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /检测到拼图，需要人工介入/);
  assert.match(h.alerts[0], /不会自动求解或代滑/);
  assert.match(h.alerts[0], /无需点击确认/);
  assert.match(h.alerts[0], /自动结束这次控屏，清空搜索框并重查原号码/);
  assert.equal(JSON.stringify(h.state.userLookupSessions), before);
  assert.equal(h.actions.length, 0);
});

test("queued rows and legacy jigsaw classification cannot hide the blocker", () => {
  const session = blockedSession();
  session.results.unshift({ resultId: "later-query", status: "queued" });
  session.results[1].status = "limit_reached";
  const h = browserHarness(session);
  h.notify(); h.flush();
  assert.equal(h.alerts.length, 1);
  assert.equal(h.context.resumableLookupHumanVerificationResult(session).resultId, "query-original");
});

test("a failed manual resume on the same query re-arms exactly one prompt", () => {
  const h = browserHarness();
  h.notify(); h.flush();
  const session = h.state.userLookupSessions[0];
  session.status = "querying";
  session.pendingJobId = "resume-job";
  h.notify();
  session.status = "ready";
  session.pendingJobId = "";
  h.notify(); h.notify(); h.flush();
  assert.equal(h.alerts.length, 2);
});

test("an old deferred callback cannot duplicate a new prompt for the same query", () => {
  const h = browserHarness();
  const session = h.state.userLookupSessions[0];
  h.notify();
  session.pendingJobId = "resume-job";
  h.notify();
  session.pendingJobId = "";
  h.notify(); h.flush();
  assert.equal(h.alerts.length, 1);
});

for (const [name, change] of [
  ["leaving device detail", (state) => { state.userWorkbenchView = "inventory"; }],
  ["changing the selected phone", (state) => { state.userSelectedDeviceId = "other-device"; }],
  ["switching away from the workbench", (state) => { state.page = "dashboard"; }],
  ["logging out", (state) => { state.token = ""; }],
  ["replacing the login session", (state) => { state.token = "another-synthetic-session"; }],
  ["finishing the query", (state) => { state.userLookupSessions[0].results[0].status = "succeeded"; }],
  ["ending the lookup session", (state) => { state.userLookupSessions[0].status = "ended"; }]
]) {
  test(`${name} suppresses a stale deferred popup`, () => {
    const h = browserHarness();
    h.notify(); change(h.state); h.flush();
    assert.equal(h.alerts.length, 0);
  });
}

test("a hidden detail does not consume the notification; it appears on return", () => {
  const h = browserHarness();
  h.state.userWorkbenchView = "inventory";
  h.notify(); h.flush();
  assert.equal(h.alerts.length, 0);
  h.state.userWorkbenchView = "detail";
  h.notify(); h.flush();
  assert.equal(h.alerts.length, 1);
});

test("an older historical jigsaw does not prompt after a newer result completes", () => {
  const session = blockedSession();
  session.results.unshift({ resultId: "newer-query", status: "succeeded" });
  const h = browserHarness(session);
  h.notify(); h.flush();
  assert.equal(h.alerts.length, 0);
});

test("human state blocks new input and account switching, removes confirmation and keeps end", async () => {
  const h = browserHarness();
  h.render();
  assert.match(h.els.userLookupSessionStatus.innerHTML, /当前号码等待人工验证/);
  for (const name of ["userLookupPhoneInput", "userLookupQueryButton", "userLookupSwitchButton"]) assert.equal(h.els[name].disabled, true);
  assert.equal(h.els.userLookupHumanResumePanel.hidden, false);
  assert.equal(h.els.userLookupHumanResumeButton.disabled, true);
  assert.equal(h.els.userLookupHumanResumeButton.hidden, true);
  assert.equal(h.els.userLookupEndButton.disabled, false);
  await h.context.submitLookupQuery();
  await h.context.submitLookupAccountAction("synthetic-account");
  assert.equal(h.actions.length, 0);
  h.device.screenControlBusy = true;
  h.render();
  assert.equal(h.els.userLookupHumanResumeButton.disabled, true);
  assert.match(h.els.userLookupHint.textContent, /当前号码和后续队列保持暂停/);
});

function serverHarness(session = blockedSession(), { screenActive = false } = {}) {
  const mutations = [];
  const context = vm.createContext({
    req: { method: "POST" }, res: {}, state: { automationSessions: [session] },
    requireAuth: () => ({ userId: "user-synthetic", role: "user" }),
    readJson: async () => ({ phoneNumber: "13800000001" }),
    json: (_res, status, body) => ({ status, body }),
    publicLookupSession, resumableLookupHumanVerificationResult, resumableLookupRecoveryResult,
    normalizeLookupPhone: (phone) => phone, normalizeLookupAccountChoice: (account) => account,
    repos: { devices: { findById: () => ({ deviceId: session.deviceId }) } },
    isAdbOnline: () => true,
    screenSessions: { activeForDevice: () => screenActive },
    createAutomationJob: (input) => { mutations.push(["create", input]); return { ...input, jobId: "new-job" }; },
    upsertLookupResult: (_session, job) => mutations.push(["upsert", job]),
    queueAutomationWindowsTask: (_device, job) => { mutations.push(["queue", job]); return { taskId: "synthetic-task" }; },
    addAudit: () => ({}), nowIso: () => "2026-10-08T00:00:00.000Z",
    publicAutomationJob: (job) => job,
    persistencePolicy: { persist: async (fn) => fn() },
    structuredRepos: { persistTaskMutation: async () => mutations.push(["persist"]) }
  });
  const routes = {
    queries: section(server, "  const lookupQueryMatch =", "  const lookupHumanResumeMatch ="),
    "resume-after-human-verification": section(server, "  const lookupHumanResumeMatch =", "  const lookupEndMatch ="),
    "switch-account": section(server, "  const lookupSwitchMatch =", '  if (req.method === "POST" && lookupEndMatch)')
  };
  return {
    mutations,
    request: (action) => {
      context.url = { pathname: `/api/v1/user/automation/alipay-name-sessions/${session.sessionId}/${action}` };
      return vm.runInContext(`(async () => { ${routes[action]} })()`, context);
    }
  };
}

for (const action of ["queries", "switch-account"]) {
  test(`server rejects ${action} while human verification is unresolved without mutating the original query`, async () => {
    const session = blockedSession();
    const before = JSON.stringify(session);
    const h = serverHarness(session);
    const response = await h.request(action);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "lookup_human_verification_required");
    assert.equal(h.mutations.length, 0);
    assert.equal(JSON.stringify(session), before);
  });
}

test("the explicit human resume queues only the original number and result ID", async () => {
  const session = blockedSession();
  const h = serverHarness(session);
  const response = await h.request("resume-after-human-verification");
  assert.equal(response.status, 202);
  const input = h.mutations.find(([type]) => type === "create")[1];
  assert.equal(input.resultId, "query-original");
  assert.equal(input.phoneNumber, "13800000000");
  assert.equal(input.resumeAfterHumanVerification, true);
  assert.equal(h.mutations.filter(([type]) => type === "queue").length, 1);
});

test("human resume remains blocked during active screen control", async () => {
  const h = serverHarness(blockedSession(), { screenActive: true });
  assert.equal((await h.request("resume-after-human-verification")).body.error, "lookup_screen_control_active");
  assert.equal(h.mutations.length, 0);
});

test("a resolved blocker allows a later normal query again", async () => {
  const session = blockedSession();
  session.results[0].status = "succeeded";
  const h = serverHarness(session);
  assert.equal((await h.request("queries")).status, 202);
  assert.equal(h.mutations.filter(([type]) => type === "queue").length, 1);
});

test("the external queue does not dispatch a later number before manual recovery", () => {
  const session = blockedSession();
  const context = vm.createContext({
    resumableLookupHumanVerificationResult, resumableLookupRecoveryResult,
    refreshOpenLookupQueuePositions: () => [{ jobId: "later-query" }],
    queueAutomationWindowsTask: () => { assert.fail("blocked queue must not send to an Agent"); }
  });
  vm.runInContext(section(server, "function dispatchNextOpenLookupQuery(session)", "function cancelQueuedOpenLookupQueries"), context);
  assert.equal(context.dispatchNextOpenLookupQuery(session), null);
});

test("the active device render invokes the prompt without adding any solver integration", () => {
  assert.match(app, /renderLookupSession\(lookupSession, selectedDevice\);\s*renderUserScreenControl\(selectedDevice\);\s*notifyLookupHumanVerification\(lookupSession, selectedDevice\);/);
  for (const file of [app, server, fs.readFileSync(new URL("../windows-agent/src/index.mjs", import.meta.url), "utf8")]) {
    assert.doesNotMatch(file, /jigsaw_opencv_solver/);
  }
});

async function screenStatusHarness() {
  const device = { deviceId: "device-synthetic" };
  const released = [];
  const state = { userDevices: [device], userSelectedDeviceId: device.deviceId, userScreenStarting: false };
  let options;
  const context = vm.createContext({
    state, els: { userScreenVideo: {} },
    window: { PhoneCloudScreenController: class {
      constructor(input) { options = input; }
      connect() {}
    } },
    userScreenInactivityGuard: { start() {}, stop() {} },
    renderUserScreenControl() {},
    api: async () => ({ session: { sessionId: "screen-synthetic" }, browserToken: "synthetic-token" }),
    releaseFailedUserScreenSession: (id) => released.push(id)
  });
  vm.runInContext(section(app, "async function startUserScreenSession()", "function releaseFailedUserScreenSession"), context);
  await context.startUserScreenSession();
  return { state, released, emit: (message) => options.onStatus(message) };
}

test("normal human handover close shows business completion and preserves existing cleanup", async () => {
  const h = await screenStatusHarness();
  h.emit({ status: "closed", detail: "控制通道连接失败（1000：lookup_human_verification_completed）" });
  assert.equal(h.state.userScreenStatus, "closed");
  assert.equal(h.state.userScreenDetail, "人工验证已完成，控屏已自动结束；脚本正在重查原号码。");
  assert.equal(h.state.userScreenSession, null);
  assert.equal(h.state.userScreenToken, "");
  assert.equal(h.state.userScreenDeviceId, "");
  assert.deepEqual(h.released, ["screen-synthetic"]);
});

test("unrelated closes and real failures are never relabeled as human completion", async () => {
  for (const message of [
    { status: "closed", detail: "控制通道连接失败（1006）" },
    { status: "closed", detail: "控制通道连接失败（4000：lookup_human_verification_completed）" },
    { status: "closed", detail: "控制通道连接失败（1000：lookup_human_verification_completed_extra）" },
    { status: "failed", detail: "控制通道连接失败（1000：lookup_human_verification_completed）" },
    { status: "live", detail: "lookup_human_verification_completed" }
  ]) {
    const h = await screenStatusHarness();
    h.emit(message);
    assert.equal(h.state.userScreenStatus, message.status);
    assert.equal(h.state.userScreenDetail, message.detail);
  }
});


test("ordinary recovery failure blocks new work and shows retry without a puzzle alert", async () => {
  const session = blockedSession();
  session.results[0] = { ...session.results[0], status: "needs_recovery", limitReason: "", errorCode: "alipay_page_element_changed" };
  const h = browserHarness(session);
  h.notify(); h.flush(); h.render();
  assert.equal(h.alerts.length, 0);
  assert.equal(h.els.userLookupPhoneInput.disabled, true);
  assert.equal(h.els.userLookupSwitchButton.disabled, true);
  assert.equal(h.els.userLookupRecoveryRetryButton.hidden, false);
  assert.equal(h.els.userLookupRecoveryRetryButton.disabled, false);
  for (const action of ["queries", "switch-account"]) {
    const cloud = serverHarness(structuredClone(session));
    assert.equal((await cloud.request(action)).body.error, "lookup_recovery_required");
  }
  const cloud = serverHarness(session);
  assert.equal((await cloud.request("resume-after-human-verification")).status, 202);
  const input = cloud.mutations.find(([type]) => type === "create")[1];
  assert.equal(input.phoneNumber, "13800000000");
  assert.equal(input.resultId, "query-original");
  assert.equal(input.restartAfterHumanVerification, true);
});

test("startup puzzle is visible without inventing a query result", () => {
  const session = blockedSession({ status: "needs_human_verification", results: [],
    startupHumanVerification: { phase: "start", resultId: "startup", status: "needs_human_verification", limitReason: "jigsaw_verification" } });
  const h = browserHarness(session); h.notify(); h.flush(); h.render();
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /账户准备和后续队列已暂停/);
  assert.equal(h.els.userLookupPhoneInput.disabled, true);
  assert.equal(h.els.userLookupHumanResumeButton.hidden, true);
  assert.equal(session.results.length, 0);
});
