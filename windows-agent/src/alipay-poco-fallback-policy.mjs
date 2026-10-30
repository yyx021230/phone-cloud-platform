import {lookupReaderCleanupFailure} from './lookup-cleanup-policy.mjs';

const NON_FALLBACK_RESULTS = [
  "local_lookup_result_unconfirmed:",
  "poco_alipay_person_result_not_found",
  "poco_alipay_human_verification_required",
  "poco_alipay_human_verification_repeatedly_invalidated_query",
  "poco_alipay_login_required",
  "invalid_phone_number",
  "device_not_online",
  "alipay_not_installed",
  "alipay_access_denied_account_switch_required",
  "alipay_account_restriction_switch_required:",
  "alipay_account_restriction_before_search:",
  "poco_rpc_failed:",
  "Airtest/Poco worker 探活未通过",
  "Cannot find any visible node by query",
  "poco_query_result_channel_timeout_after_input:",
  "poco_query_resume_failed:"
];

export function shouldFallbackAlipayPocoFailure(error) {
  if (lookupReaderCleanupFailure(error)) return false;
  const message = String(error?.message || error || "");
  if (error?.code === 'airtest_worker_capacity_reached'
    || /^Airtest\/Poco 常驻 worker 已达到上限 \d+，当前均在执行任务$/.test(message)) return false;
  return !NON_FALLBACK_RESULTS.some((token) => message.includes(token));
}

export function isRetryableAlipayPocoStartFailure(error) {
  const message = String(error?.message || error || "");
  return message.includes("poco_rpc_failed:")
    || message.includes("Airtest/Poco worker 探活未通过");
}
