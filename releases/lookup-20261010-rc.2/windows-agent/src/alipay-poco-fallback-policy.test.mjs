import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableAlipayPocoStartFailure,
  shouldFallbackAlipayPocoFailure
} from "./alipay-poco-fallback-policy.mjs";

test("does not send business no-result or verification states to XML", () => {
  for (const message of [
    "poco_alipay_person_result_not_found",
    "poco_alipay_human_verification_required",
    "poco_alipay_human_verification_repeatedly_invalidated_query",
    "poco_alipay_login_required",
    "invalid_phone_number",
    "alipay_access_denied_account_switch_required",
    "alipay_account_restriction_switch_required:jigsaw_verification",
    "alipay_account_restriction_switch_required:device_risk",
    "alipay_account_restriction_switch_required:frequent_or_abnormal_access",
    "alipay_account_restriction_before_search:device_risk",
    "poco_rpc_failed:HTTPConnectionPool read timed out",
    "Airtest/Poco worker 探活未通过：AYM7MRW4W8CY8H7H",
    "Cannot find any visible node by query UIObjectProxy of desc=搜索框",
    "poco_query_result_channel_timeout_after_input:ReadTimeout",
    "poco_query_resume_failed:poco_query_resume_snapshot_failed:ReadTimeout"
  ]) {
    assert.equal(shouldFallbackAlipayPocoFailure(new Error(message)), false, message);
  }
});

test("uses XML only when the Poco execution path is abnormal", () => {
  for (const message of [
    "poco_selector_missing:search input",
    "poco_result_page_state_changed:length=0",
    "poco_search_submit_unavailable"
  ]) {
    assert.equal(shouldFallbackAlipayPocoFailure(new Error(message)), true, message);
  }
});

test("retries only bounded Poco transport failures while establishing a session", () => {
  assert.equal(isRetryableAlipayPocoStartFailure(new Error("poco_rpc_failed:read timeout")), true);
  assert.equal(isRetryableAlipayPocoStartFailure(new Error("Airtest/Poco worker 探活未通过：serial")), true);
  assert.equal(isRetryableAlipayPocoStartFailure(new Error("poco_selector_missing:search input")), false);
  assert.equal(isRetryableAlipayPocoStartFailure(new Error("alipay_account_restriction_before_search:device_risk")), false);
});
