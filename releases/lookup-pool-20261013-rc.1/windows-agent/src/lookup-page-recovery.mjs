// Unexpected lookup failures may restart this app once, never a device or ADB.
// Business/verification/identity states are not execution failures to replay.
const PROTECTED_STATES = [
  "human_verification", "jigsaw_verification", "access_denied", "device_risk",
  "frequent_or_abnormal_access", "account_restriction", "account_switch",
  "login_required", "invalid_phone_number", "device_not_online", "alipay_not_installed",
  "person_result_not_found", "local_lookup_", "cancel", "screen_control", "capacity_reached",
  "poco_query_page_recovery_failed:"
];

export function canRestartLookupAfterFailure(operation, error) {
  if (operation !== "query") return false;
  const message = `${String(error?.code || "")} ${String(error?.message || error || "")}`.trim();
  return Boolean(message) && !PROTECTED_STATES.some((token) => message.includes(token));
}

export async function restartLookupQueryOnce({ operation, error, payload, stopWorker, runWorker, onRecovery, assertAllowed = () => {} }) {
  if (!canRestartLookupAfterFailure(operation, error)) return null;
  assertAllowed();
  await onRecovery();
  // Do not swallow a worker shutdown failure: delayed input must be cancelled
  // before app restart / original-number replay is permitted.
  if (await stopWorker() !== true) throw new Error("lookup_old_worker_exit_unconfirmed");
  assertAllowed();
  const restarted = await runWorker({ ...payload, operation: "query", recoverUnexpectedPage: true,
    pageRecoveryStage: "restart_app" });
  if (!restarted?.ok) return restarted;
  if (restarted.appRecoveryStage !== "app_restarted") throw new Error("lookup_app_restart_unconfirmed");
  // Restarting Alipay invalidates Poco's old hierarchy transport. Reattach
  // once after the app launch, without another app restart or any input yet.
  if (await stopWorker() !== true) throw new Error("lookup_restart_worker_exit_unconfirmed");
  assertAllowed();
  const continuedPayload = { ...payload, operation: "query", recoverUnexpectedPage: true,
    pageRecoveryStage: "continue_query" };
  // Search navigation can invalidate the hierarchy channel too. Only the
  // Python preparation block (which cannot enter input) may request one more
  // attach. Untagged or post-input failures must never replay this stage.
  const canReattach = (failure) => {
    const reason = `${String(failure?.code || "")} ${String(failure?.message || failure || "")}`.trim();
    return reason.includes("poco_query_page_recovery_prepare_failed:")
      && reason.includes("poco_rpc_failed:")
      && canRestartLookupAfterFailure("query", failure);
  };
  let result;
  try {
    result = await runWorker(continuedPayload);
  } catch (error) {
    if (!canReattach(error)) throw error;
    result = { ok: false, error };
  }
  if (result?.ok || !canReattach(result?.error)) return result;
  if (await stopWorker() !== true) throw new Error("lookup_prepare_worker_exit_unconfirmed");
  assertAllowed();
  return runWorker(continuedPayload);
}
