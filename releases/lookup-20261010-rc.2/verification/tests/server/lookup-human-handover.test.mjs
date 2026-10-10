import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createLookupHumanHandover, lookupHumanChallenge } from "./lookup-human-handover.mjs";
import { normalizeLookupPhone, resumableLookupHumanVerificationResult } from "./automation-center.mjs";

function policyHarness() {
  let time = 100_000;
  let target = { sessionId: "s", deviceId: "d", adbSerial: "SYNTHETIC", challengeId: "c", screenSessionId: "screen" };
  const actions = [];
  const policy = createLookupHumanHandover({ now: () => time,
    targets: (agent) => agent === "a" && target ? [target] : [],
    resume: async (item) => { actions.push(item); target = null; return true; }
  });
  return { policy, actions, advance: (ms = 3_000) => { time += ms; },
    change: (patch) => { target = patch === null ? null : { ...target, ...patch }; },
    issue: () => policy.list("a")[0],
    report: (probe, state = "search_ready", agent = "a") => policy.report(agent, { probeId: probe.probeId, state }) };
}

test("two fresh separated confirmations resume exactly once, replay cannot repeat", async () => {
  const h = policyHarness();
  const first = h.issue();
  assert.equal((await h.report(first)).resumed, false);
  h.advance();
  const second = h.issue();
  assert.equal((await h.report(second)).resumed, true);
  assert.equal((await h.report(second)).accepted, false);
  assert.equal(h.actions.length, 1);
});

for (const state of ["unknown", "present", "invalid", ""]) {
  test(`${state || "empty"} resets the clear streak`, async () => {
    const h = policyHarness();
    await h.report(h.issue()); h.advance();
    await h.report(h.issue(), state); h.advance();
    assert.equal((await h.report(h.issue())).resumed, false);
    assert.equal(h.actions.length, 0);
  });
}

for (const mutation of [null, { challengeId: "new-challenge" }, { screenSessionId: "another-screen" }, { adbSerial: "REBOUND" }]) {
  test(`cancelled/replaced/rebound target ignores old observations: ${JSON.stringify(mutation)}`, async () => {
    const h = policyHarness();
    await h.report(h.issue()); h.advance();
    const old = h.issue(); h.change(mutation);
    assert.equal((await h.report(old)).accepted, false);
    assert.equal(h.actions.length, 0);
  });
}

test("expired, foreign-Agent and out-of-order leases cannot prove clearance", async () => {
  const h = policyHarness();
  const first = h.issue(); h.advance(); const second = h.issue();
  assert.equal((await h.report(first, "search_ready", "other-agent")).accepted, false);
  await h.report(second);
  assert.equal((await h.report(first)).reason, "probe_out_of_order");
  h.advance(); const stale = h.issue(); h.advance(16_000);
  assert.equal((await h.report(stale)).accepted, false);
  assert.equal(h.actions.length, 0);
});

test("concurrent completion cannot duplicate an in-flight handover", async () => {
  let time = 10_000, count = 0, finish;
  const target = { challengeId: "c", screenSessionId: "s", deviceId: "d", adbSerial: "x" };
  const policy = createLookupHumanHandover({ now: () => time, targets: () => [target],
    resume: () => { count++; return new Promise((resolve) => { finish = resolve; }); } });
  await policy.report("a", { probeId: policy.list("a")[0].probeId, state: "search_ready" });
  time += 3_000;
  const probe = policy.list("a")[0];
  const a = policy.report("a", { probeId: probe.probeId, state: "search_ready" });
  const b = await policy.report("a", { probeId: probe.probeId, state: "search_ready" });
  assert.equal(b.accepted, false); assert.equal(count, 1);
  finish(true); assert.equal((await a).resumed, true);
});

const source = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
const start = source.indexOf("function lookupHumanProbeTargets(agentId)");
const end = source.indexOf("function queueAutomationWindowsTask(device, job)", start);
function integrationHarness({ admin = false, untagged = false, saveFails = false, cancelDuringSave = false } = {}) {
  const result = { resultId: "original", phoneNumber: "13800000000", status: "needs_human_verification",
    updatedAt: "2026-10-08T00:00:00Z", clientReference: "order", consentReference: "consent" };
  const session = { sessionId: "lookup", deviceId: "d", userId: "owner", source: "open-api", clientId: "client",
    status: "ready", pendingJobId: "", results: [result] };
  const device = { deviceId: "d", adb: { agentId: "a", serial: "SYNTHETIC" } };
  let screen = { sessionId: "screen", status: "ready", userId: admin ? "admin:admin" : "owner" };
  const mutable = { lookupHumanHandover: untagged ? null : { sessionId: session.sessionId, challengeId: lookupHumanChallenge(session) } };
  const actions = [], jobs = [];
  let task;
  const context = vm.createContext({
    state: { automationSessions: [session], deviceLocks: [{ status: "active", lockType: "alipay_name_lookup", taskId: "lookup", deviceId: "d", ownerUserId: "owner" }] },
    repos: { devices: { findById: () => device } }, isAdbOnline: () => true,
    screenSessions: { activeForDevice: () => screen, getMutable: () => mutable },
    screenRelay: { agentOnline: () => true, stop: (id) => { actions.push(["stop", id]); screen = null; return true; } },
    lookupHumanChallenge, resumableLookupHumanVerificationResult, normalizeLookupPhone,
    badRequest: (message) => new Error(message), nowIso: () => "2026-10-08T00:00:10Z",
    createAutomationJob: (input) => { const job = { jobId: "retry", status: "queued", ...input }; jobs.push(job); return job; },
    upsertLookupResult: (_s, _job, patch) => Object.assign(result, patch),
    queueAutomationWindowsTask: (_d, job) => { actions.push(["queue"]); job.agentId = "a"; task = { status: "queued" }; return task; },
    addAudit: () => ({}), runtimeSaveScheduler: { mark: () => actions.push(["save-runtime"]) },
    persistencePolicy: { persist: async (fn) => fn() },
    structuredRepos: { persistTaskMutation: async (mutation) => {
      assert.equal(mutation.windowsTask.status, "human_handover_pending", "not yet leasable while saving");
      actions.push(["persist"]);
      if (saveFails) throw new Error("synthetic storage error");
      if (cancelDuringSave) { session.status = "stopping"; session.pendingJobId = "stop-job"; }
    } }
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, session, result, actions, jobs, task: () => task };
}

for (const admin of [false, true]) {
  test(`real cloud functions stop the tagged ${admin ? "admin" : "initiator"} screen and retry original result`, async () => {
    const h = integrationHarness({ admin });
    const [target] = h.context.lookupHumanProbeTargets("a");
    assert.ok(target);
    assert.doesNotMatch(JSON.stringify(target), /phoneNumber|consent|13800000000/);
    await h.context.resumeLookupAfterObservedHumanVerification(target);
    assert.deepEqual(h.actions.map(([kind]) => kind), ["stop", "queue", "persist", "save-runtime"]);
    const [job] = h.jobs;
    assert.equal(job.phoneNumber, "13800000000"); assert.equal(job.resultId, "original");
    assert.equal(job.restartAfterHumanVerification, true); assert.equal(job.resumeAfterHumanVerification, true);
    assert.equal(job.clientId, "client"); assert.equal(job.consentReference, "consent"); assert.equal(job.clientReference, "order");
    assert.equal(h.task().status, "queued");
    assert.equal(h.context.lookupHumanProbeTargets("a").length, 0);
  });
}

test("unrelated or untagged screen and a foreign Agent do not get an observer target", () => {
  assert.equal(integrationHarness({ untagged: true }).context.lookupHumanProbeTargets("a").length, 0);
  assert.equal(integrationHarness().context.lookupHumanProbeTargets("wrong-agent").length, 0);
});

test("persistence failure holds the retry and cannot queue an automatic second attempt", async () => {
  const h = integrationHarness({ saveFails: true });
  const [target] = h.context.lookupHumanProbeTargets("a");
  await assert.rejects(h.context.resumeLookupAfterObservedHumanVerification(target), /persist_failed/);
  assert.equal(h.task().status, "human_handover_pending");
  assert.equal(h.session.pendingJobId, "retry");
  assert.equal(h.context.lookupHumanProbeTargets("a").length, 0);
  assert.equal(h.jobs.length, 1);
});

test("cancellation while saving never resurrects a held query", async () => {
  const h = integrationHarness({ cancelDuringSave: true });
  await h.context.resumeLookupAfterObservedHumanVerification(h.context.lookupHumanProbeTargets("a")[0]);
  assert.equal(h.task().status, "human_handover_pending");
  assert.equal(h.session.status, "stopping");
});

test("observer route uses bound Agent authentication and existing read/write scopes", () => {
  const route = source.slice(source.indexOf("  const humanProbeMatch ="), source.indexOf("  const nextTaskMatch ="));
  assert.match(route, /requireWindowsAgent\(req, agentId\)/);
  assert.match(route, /requireWindowsScope\(ctx, req.method === "GET" \? "tasks:read" : "tasks:write"\)/);
  assert.doesNotMatch(route, /requireAuth|phoneNumber/);
});
