import assert from "node:assert/strict";
import test from "node:test";
import { shouldFallbackAlipayPocoFailure } from "./alipay-poco-fallback-policy.mjs";

test("does not send business no-result or verification states to XML", () => {
  for (const message of [
    "poco_alipay_person_result_not_found",
    "poco_alipay_human_verification_required",
    "poco_alipay_human_verification_repeatedly_invalidated_query",
    "invalid_phone_number"
  ]) {
    assert.equal(shouldFallbackAlipayPocoFailure(new Error(message)), false, message);
  }
});

test("uses XML only when the Poco execution path is abnormal", () => {
  for (const message of [
    "poco_rpc_failed:connection reset",
    "poco_selector_missing:search input",
    "poco_result_page_state_changed:length=0",
    "poco_search_submit_unavailable",
    "alipay_access_denied_account_switch_required"
  ]) {
    assert.equal(shouldFallbackAlipayPocoFailure(new Error(message)), true, message);
  }
});
