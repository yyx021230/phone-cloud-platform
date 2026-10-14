import assert from "node:assert/strict";
import test from "node:test";
import {
  automationLockType,
  hasVerifiedAllSavedAccountsRestricted,
  isPostQueryLookupRestrictionEvent,
  isActiveAutomationStatus,
  lookupHumanRecoveryUnresolved,
  normalizeAutomationKind,
  normalizeLookupAccountChoice,
  normalizeLookupPhone,
  publicAutomationJob,
  publicLookupSession,
  resumableLookupHumanVerificationResult,
  upsertLookupRestrictionHistory
} from "./automation-center.mjs";

test("normalizes the supported automation commands", () => {
  for (const kind of ["xhs_publish", "xhs_data_collect", "alipay_name_start", "alipay_name_query", "alipay_name_switch", "alipay_name_stop"]) {
    assert.equal(normalizeAutomationKind(kind), kind);
  }
  assert.throws(() => normalizeAutomationKind("screen_control"), /unsupported_automation_kind/);
});

test("accepts only mainland mobile numbers", () => {
  assert.equal(normalizeLookupPhone("138-0013-8000"), "13800138000");
  assert.throws(() => normalizeLookupPhone("10086"), /invalid_phone_number/);
});

test("only the latest idle human-verification result can resume", () => {
  const humanResult = { resultId: "result-1", phoneNumber: "13800138000", status: "needs_human_verification" };
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [humanResult] }), humanResult);
  const jigsawResult = { ...humanResult, status: "limit_reached", limitReason: "jigsaw_verification" };
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [jigsawResult] }), jigsawResult);
  assert.equal(resumableLookupHumanVerificationResult({ status: "querying", pendingJobId: "job-1", results: [humanResult] }), null);
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [{ status: "succeeded" }, humanResult] }), null);
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [{ status: "queued", queuePosition: 1 }, humanResult] }), humanResult);
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [{ status: "queued" }, humanResult] }), humanResult);
  assert.equal(resumableLookupHumanVerificationResult({ status: "ready", pendingJobId: "", results: [{ status: "succeeded", limitReason: "jigsaw_verification" }] }), null);
});

test("an unresolved human recovery keeps the current number ahead of the queue", () => {
  const resumeJob = { resumeAfterHumanVerification: true };
  assert.equal(lookupHumanRecoveryUnresolved(resumeJob, "failed"), true);
  assert.equal(lookupHumanRecoveryUnresolved(resumeJob, "cancelled"), false);
  assert.equal(lookupHumanRecoveryUnresolved(resumeJob, "failed", { humanVerificationStillPresent: true }), true);
  assert.equal(lookupHumanRecoveryUnresolved(resumeJob, "succeeded"), false);
  assert.equal(lookupHumanRecoveryUnresolved(resumeJob, "failed", { limitReached: true, humanVerificationStillPresent: true }), false);
  assert.equal(lookupHumanRecoveryUnresolved({}, "failed"), false);
});

test("pauses lookup only after every saved account has restriction evidence", () => {
  const complete = {
    code: "alipay_all_saved_accounts_restricted",
    savedAccountCount: 5,
    restrictedAccounts: ["a", "b", "c", "d", "e"],
    accountSwitchCount: 4,
    accountSwitchHistory: [{}, {}, {}, {}]
  };
  assert.equal(hasVerifiedAllSavedAccountsRestricted(complete), true);
  assert.equal(hasVerifiedAllSavedAccountsRestricted({ ...complete, restrictedAccounts: ["a", "b", "c", "d"] }), false);
  assert.equal(hasVerifiedAllSavedAccountsRestricted({ ...complete, restrictedAccounts: ["a", "b", "c", "d", "d"] }), false);
  assert.equal(hasVerifiedAllSavedAccountsRestricted({ ...complete, accountSwitchCount: 3 }), false);
  assert.equal(hasVerifiedAllSavedAccountsRestricted({ ...complete, accountSwitchHistory: [{}, {}, {}] }), false);
  assert.equal(hasVerifiedAllSavedAccountsRestricted({ ...complete, code: "alipay_account_restriction_switch_required" }), false);
});

test("accepts only bounded account choices returned by the phone", () => {
  assert.equal(normalizeLookupAccountChoice(" 155******36 "), "155******36");
  assert.throws(() => normalizeLookupAccountChoice(""), /invalid_lookup_account_choice/);
  assert.throws(() => normalizeLookupAccountChoice("155******36\nother"), /invalid_lookup_account_choice/);
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

test("records only evidenced post-query account restrictions for future switching", () => {
  const event = {
    stepId: "alipay_account_restriction_detected",
    detail: {
      reason: "jigsaw_verification",
      driver: "poco",
      phoneQueryStarted: true,
      accountSwitchRequired: true
    }
  };
  assert.equal(isPostQueryLookupRestrictionEvent(event), true);
  assert.equal(isPostQueryLookupRestrictionEvent({ ...event, detail: { ...event.detail, phoneQueryStarted: false } }), false);
  const session = { deviceId: "device-182" };
  upsertLookupRestrictionHistory(session, {
    jobId: "job-1",
    phoneNumber: "13687366441",
    reason: "jigsaw_verification",
    status: "detected",
    detectedAt: "2026-09-01T07:47:14.793Z"
  });
  upsertLookupRestrictionHistory(session, {
    jobId: "job-1",
    reason: "jigsaw_verification",
    status: "confirmed",
    errorCode: "alipay_account_restriction_switch_required",
    confirmedAt: "2026-09-01T07:47:14.900Z"
  });
  assert.equal(session.restrictionHistory.length, 1);
  assert.equal(session.restrictionHistory[0].status, "confirmed");
  assert.equal(session.restrictionHistory[0].phoneNumber, "13687366441");
  assert.equal(session.restrictionHistory[0].deviceId, "device-182");
});

test("public models bound histories and expose session progress", () => {
  const job = publicAutomationJob({ jobId: "j1", status: "running", events: Array.from({ length: 50 }, (_, index) => ({ index })) });
  assert.equal(job.events.length, 30);
  assert.equal(job.cancellable, true);
  const session = publicLookupSession({ sessionId: "s1", successfulCount: 200, requiresAccountSwitch: true, limitReason: "device_risk", lastAccountSwitch: { fromAccount: "155******36", toAccount: "198******91", switchedAt: "2026-08-31T00:00:00.000Z", ignored: "secret" }, accountChoices: [{ account: "155******36", current: true, ignored: "secret" }, { account: "198******91", current: false }], restrictionHistory: [{ restrictionId: "j1", phoneNumber: "13687366441", reason: "device_risk", phoneQueryStarted: true, requiresAccountSwitch: true, ignored: "secret" }], results: Array.from({ length: 700 }, (_, index) => ({ index })) });
  assert.equal(session.successfulCount, 200);
  assert.equal(session.requiresAccountSwitch, true);
  assert.equal(session.limitReason, "device_risk");
  assert.deepEqual(session.lastAccountSwitch, { fromAccount: "155******36", toAccount: "198******91", switchedAt: "2026-08-31T00:00:00.000Z" });
  assert.deepEqual(session.accountChoices, [{ account: "155******36", current: true }, { account: "198******91", current: false }]);
  assert.equal(session.restrictionHistory.length, 1);
  assert.equal(session.restrictionHistory[0].reason, "device_risk");
  assert.equal("ignored" in session.restrictionHistory[0], false);
  assert.equal(session.results.length, 500);
});
