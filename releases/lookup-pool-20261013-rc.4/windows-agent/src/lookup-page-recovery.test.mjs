import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { canRestartLookupAfterFailure, restartLookupQueryOnce } from "./lookup-page-recovery.mjs";

test("unexpected failures before/during/after input all enter app recovery", () => {
  for (const error of ["poco_query_before_input_failed:editableLength=None",
    "poco_query_result_channel_timeout_after_input:ReadTimeout",
    "poco_query_resume_failed:poco_query_resume_state_mismatch:length=0",
    "poco_rpc_failed:ReadTimeout", "poco_search_submit_unavailable", "unexpected_popup"]) {
    assert.equal(canRestartLookupAfterFailure("query", new Error(error)), true);
  }
});
test("verification, restrictions, login, cancellation and expected outcomes stay paused", () => {
  for (const error of ["poco_alipay_human_verification_required", "jigsaw_verification",
    "access_denied", "device_risk", "frequent_or_abnormal_access", "alipay_account_restriction_before_search",
    "login_required", "invalid_phone_number", "device_not_online", "alipay_not_installed",
    "poco_alipay_person_result_not_found", "local_lookup_restriction_stopped", "task_cancelled", "screen_control_active"]) {
    assert.equal(canRestartLookupAfterFailure("query", error), false, error);
  }
  for (const operation of ["start", "stop", "switch", "list_accounts", "query_resume"]) {
    assert.equal(canRestartLookupAfterFailure(operation, "unexpected"), false);
  }
});
test("a recovery failure never enters another app restart", () => {
  assert.equal(canRestartLookupAfterFailure("query", "poco_query_page_recovery_failed:timeout"), false);
});
test("terminates old worker before one same-task/same-number recovery", async () => {
  const order = []; const payload = { serial: "LOCAL", phoneNumber: "13800138000", taskId: "one", operation: "query" };
  const result = await restartLookupQueryOnce({ operation: "query", error: "unexpected", payload,
    onRecovery: async () => order.push("event"), stopWorker: async () => { order.push("stop"); return true; },
    runWorker: async (p) => { order.push(p.pageRecoveryStage); assert.equal(p.taskId, payload.taskId);
      assert.equal(p.phoneNumber, payload.phoneNumber); assert.equal(p.serial, payload.serial);
      assert.equal(p.recoverUnexpectedPage, true); return { ok: true, appRecoveryStage: "app_restarted" }; } });
  assert.deepEqual(order, ["event", "stop", "restart_app", "stop", "continue_query"]); assert.equal(result.ok, true);
});
test("worker shutdown failure blocks restart and replay", async () => {
  let runs = 0;
  await assert.rejects(restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
    onRecovery: async () => {}, stopWorker: async () => { throw new Error("worker still running"); },
    runWorker: async () => { runs++; } }), /worker still running/);
  assert.equal(runs, 0);
});
test("protected failures produce no recovery side effect", async () => {
  const fail = () => { throw new Error("must not run"); };
  assert.equal(await restartLookupQueryOnce({ operation: "query", error: "human_verification",
    payload: {}, onRecovery: fail, stopWorker: fail, runWorker: fail }), null);
});
test("an unconfirmed worker exit also blocks all app actions", async () => {
  let runs = 0;
  await assert.rejects(restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
    onRecovery: async () => {}, stopWorker: async () => false,
    runWorker: async () => { runs++; } }), /exit_unconfirmed/);
  assert.equal(runs, 0);
});
test("cancellation during worker shutdown prevents app restart", async () => {
  let allowed = true; let runs = 0;
  await assert.rejects(restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
    assertAllowed: () => { if (!allowed) throw new Error("task_cancelled"); },
    onRecovery: async () => {}, stopWorker: async () => { allowed = false; return true; },
    runWorker: async () => { runs++; } }), /task_cancelled/);
  assert.equal(runs, 0);
});
test("a protected error code cannot be hidden by a user-facing message", () => {
  assert.equal(canRestartLookupAfterFailure("query", { code: "local_lookup_restriction_stopped", message: "暂停" }), false);
});

test("one pre-input preparation transport failure reattaches without another app restart", async () => {
  for (const thrown of [false, true]) {
    const calls = []; let stops = 0;
    const failure = "poco_query_page_recovery_prepare_failed:poco_rpc_failed:read timeout";
    const result = await restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: { taskId: "same", phoneNumber: "13800138000" },
      onRecovery: async () => {}, stopWorker: async () => { stops++; return true; },
      runWorker: async (p) => { calls.push(p);
        if (calls.length === 1) return { ok: true, appRecoveryStage: "app_restarted" };
        if (calls.length === 2) { if (thrown) throw new Error(failure); return { ok: false, error: failure }; }
        return { ok: true, notFound: true };
      } });
    assert.equal(result.ok, true); assert.equal(stops, 3);
    assert.deepEqual(calls.map(x => x.pageRecoveryStage), ["restart_app", "continue_query", "continue_query"]);
    assert.ok(calls.every(x => x.taskId === "same" && x.phoneNumber === "13800138000"));
  }
});
test("only tagged pre-input transport failure can retry, and only once", async () => {
  for (const error of ["poco_rpc_failed:timeout", "poco_query_result_channel_timeout_after_input:timeout",
    "poco_query_page_recovery_prepare_failed:poco_selector_missing:search",
    "poco_query_page_recovery_prepare_failed:poco_rpc_failed:human_verification_required"]) {
    let runs = 0;
    const result = await restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
      onRecovery: async () => {}, stopWorker: async () => true, runWorker: async () => ++runs === 1
        ? { ok: true, appRecoveryStage: "app_restarted" } : { ok: false, error } });
    assert.equal(result.ok, false); assert.equal(runs, 2);
  }
  let runs = 0;
  const result = await restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
    onRecovery: async () => {}, stopWorker: async () => true, runWorker: async () => ++runs === 1
      ? { ok: true, appRecoveryStage: "app_restarted" }
      : { ok: false, error: "poco_query_page_recovery_prepare_failed:poco_rpc_failed:timeout" } });
  assert.equal(result.ok, false); assert.equal(runs, 3);
});
test("cancel or unconfirmed exit blocks the pre-input transport reattach", async () => {
  for (const cancel of [false, true]) {
    let runs = 0, stops = 0, allowed = true;
    await assert.rejects(restartLookupQueryOnce({ operation: "query", error: "unexpected", payload: {},
      assertAllowed: () => { if (!allowed) throw new Error("task_cancelled"); }, onRecovery: async () => {},
      stopWorker: async () => { stops++; if (stops === 3) { allowed = !cancel; return cancel; } return true; },
      runWorker: async () => ++runs === 1 ? { ok: true, appRecoveryStage: "app_restarted" }
        : { ok: false, error: "poco_query_page_recovery_prepare_failed:poco_rpc_failed:timeout" } }),
    cancel ? /task_cancelled/ : /exit_unconfirmed/);
    assert.equal(runs, 2);
  }
});

function realTaskHarness(responses, stopResult = true) {
  const source = fs.readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("async function taskAlipayNameLookup(");
  const end = source.indexOf("\nasync function assertAdbDeviceOnline(", begin);
  assert.ok(begin >= 0 && end > begin);
  const calls = []; let stops = 0;
  const dependencies = {
    config: { alipayNameLookupRunnerPath: "synthetic", adbPath: "fake-adb" },
    fileExists: async () => true, assertAdbDeviceOnlineFast: async () => {},
    isPackageInstalled: async () => true, taskEvent: async () => {},
    touchAirtestLookupWarmLease: () => {}, screenControlledSerials: new Set(),
    isAutomationTaskCancellation: (e) => e.code === "automation_task_cancelled",
    automationTaskCancellationError: () => Object.assign(new Error("cancelled"), { code: "automation_task_cancelled" }),
    screenPriorityCancellationError: () => new Error("screen_control_priority"),
    restartLookupQueryOnce,
    runXhsAirtestPocoWorker: async (payload) => {
      calls.push(payload); const r = responses.shift();
      if (r instanceof Error) throw r;
      if (!r) throw new Error("unexpected extra worker call");
      return r;
    },
    stopAirtestWorker: async () => { stops++; return stopResult; },
    replayAirtestEvents: async () => {},
    classifyAlipayNameLookupFailure: (e) => ({ code: e.includes("human_verification") ? "human_verification" : "failed", message: e }),
    alipayAccountSwitchReasonFromError: () => "",
    shouldFallbackAlipayPocoFailure: () => false,
    ensureXmlUiAutomatorReady: async () => { throw new Error("XML must not run"); }
  };
  const fn = new Function(...Object.keys(dependencies), source.slice(begin, end) + "; return taskAlipayNameLookup;")(...Object.values(dependencies));
  return { run: (signal) => fn({ type: "alipay_name_query", taskId: "original", adbSerial: "LOCAL",
    payload: { phoneNumber: "13800138000" } }, { signal }), calls, stops: () => stops };
}

test("actual Agent function recovers both thrown transport and parsed page errors", async () => {
  for (const failure of [new Error("transport_failed"), { ok: false, error: "unexpected_popup", log: [] }]) {
    const h = realTaskHarness([failure, { ok: true, appRecoveryStage: "app_restarted", log: [] }, { ok: true, notFound: true, log: [] }]);
    const result = await h.run();
    assert.equal(result.notFound, true); assert.equal(result.recoveryAttempts, 1);
    assert.equal(h.stops(), 2); assert.equal(h.calls.length, 3);
    assert.equal(h.calls[1].taskId, h.calls[0].taskId);
    assert.equal(h.calls[1].phoneNumber, h.calls[0].phoneNumber);
    assert.equal(h.calls[1].recoverUnexpectedPage, true);
    assert.equal(h.calls[1].pageRecoveryStage, "restart_app");
    assert.equal(h.calls[2].pageRecoveryStage, "continue_query");
  }
});
test("actual Agent recovery failure terminates without another restart or XML", async () => {
  const h = realTaskHarness([{ ok: false, error: "unexpected" }, { ok: false, error: "still_wrong_page" }]);
  await assert.rejects(h.run(), /poco_query_page_recovery_failed/);
  assert.equal(h.calls.length, 2); assert.equal(h.stops(), 1);
});
test("actual Agent retries tagged preparation once, with the original task and no extra app restart", async () => {
  const h = realTaskHarness([{ ok: false, error: "unexpected_popup" },
    { ok: true, appRecoveryStage: "app_restarted", log: [] },
    { ok: false, error: "poco_query_page_recovery_prepare_failed:poco_rpc_failed:timeout" },
    { ok: true, notFound: true, log: [] }]);
  const result = await h.run();
  assert.equal(result.recoveryAttempts, 1); assert.equal(h.stops(), 3);
  assert.equal(h.calls.filter(x => x.pageRecoveryStage === "restart_app").length, 1);
  assert.equal(h.calls.filter(x => x.pageRecoveryStage === "continue_query").length, 2);
  assert.ok(h.calls.every(x => x.taskId === "original" && x.phoneNumber === "13800138000"));
});
test("actual Agent protected human error is never restarted", async () => {
  const h = realTaskHarness([{ ok: false, error: "poco_alipay_human_verification_required" }]);
  await assert.rejects(h.run(), /human_verification/);
  assert.equal(h.calls.length, 1); assert.equal(h.stops(), 0);
});
test("actual Agent cancellation blocks recovery before app side effects", async () => {
  const signal = new AbortController(); signal.abort();
  const h = realTaskHarness([new Error("transport_failed")]);
  await assert.rejects(h.run(signal.signal), { code: "automation_task_cancelled" });
  assert.equal(h.calls.length, 1); assert.equal(h.stops(), 0);
});


test("actual Agent unconfirmed card never restarts, reinputs or falls back to XML", async () => {
  const h = realTaskHarness([{ ok: false, error: "local_lookup_result_unconfirmed:visual_card_not_proven" }]);
  await assert.rejects(h.run(), /local_lookup_result_unconfirmed/);
  assert.equal(h.calls.length, 1); assert.equal(h.stops(), 0);
});
