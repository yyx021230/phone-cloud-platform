import assert from "node:assert/strict";
import test from "node:test";
import {
  automationLockType,
  isActiveAutomationStatus,
  normalizeAutomationKind,
  normalizeLookupPhone,
  publicAutomationJob,
  publicLookupSession
} from "./automation-center.mjs";

test("normalizes the four supported automation commands", () => {
  for (const kind of ["xhs_publish", "xhs_data_collect", "alipay_name_start", "alipay_name_query", "alipay_name_stop"]) {
    assert.equal(normalizeAutomationKind(kind), kind);
  }
  assert.throws(() => normalizeAutomationKind("screen_control"), /unsupported_automation_kind/);
});

test("accepts only mainland mobile numbers", () => {
  assert.equal(normalizeLookupPhone("138-0013-8000"), "13800138000");
  assert.throws(() => normalizeLookupPhone("10086"), /invalid_phone_number/);
});

test("keeps lookup session active only for non-terminal task states", () => {
  for (const status of ["queued", "running", "stalled"]) assert.equal(isActiveAutomationStatus(status), true);
  for (const status of ["succeeded", "failed", "cancelled", "expired"]) assert.equal(isActiveAutomationStatus(status), false);
});

test("maps publish and lookup to distinct device locks", () => {
  assert.equal(automationLockType("xhs_publish"), "xhs_publish");
  assert.equal(automationLockType("xhs_data_collect"), "xhs_data_collect");
  assert.equal(automationLockType("alipay_name_query"), "alipay_name_lookup");
});

test("public models bound histories and expose session progress", () => {
  const job = publicAutomationJob({ jobId: "j1", status: "running", events: Array.from({ length: 50 }, (_, index) => ({ index })) });
  assert.equal(job.events.length, 30);
  assert.equal(job.cancellable, true);
  const session = publicLookupSession({ sessionId: "s1", successfulCount: 200, switchEvery: 200, results: Array.from({ length: 700 }, (_, index) => ({ index })) });
  assert.equal(session.successfulCount, 200);
  assert.equal(session.results.length, 500);
});
