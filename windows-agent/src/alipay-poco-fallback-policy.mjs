const NON_FALLBACK_RESULTS = [
  "poco_alipay_person_result_not_found",
  "poco_alipay_human_verification_required",
  "poco_alipay_human_verification_repeatedly_invalidated_query",
  "invalid_phone_number",
  "device_not_online",
  "alipay_not_installed"
];

export function shouldFallbackAlipayPocoFailure(error) {
  const message = String(error?.message || error || "");
  return !NON_FALLBACK_RESULTS.some((token) => message.includes(token));
}
