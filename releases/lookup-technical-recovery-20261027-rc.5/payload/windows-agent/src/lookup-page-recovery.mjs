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

// Only the runner's explicit pre-input boundary proves no new number was
// delivered. A read timeout on that boundary may reattach this serial once;
// never replay a tap, post-input failure, login/limit/puzzle or unknown exit.
function canReattachBeforeInput(error) {
  const reason = `${String(error?.code || "")} ${String(error?.message || error || "")}`.trim();
  return canRestartLookupAfterFailure("query", error)
    && reason.includes("poco_query_before_input_failed:")
    && /read timed out|ReadTimeout/.test(reason);
}

export async function restartLookupQueryOnce({ operation, error, payload, submitted = false, resultRecoveryAttempted = false, stopWorker, runWorker, onRecovery, assertAllowed = () => {} }) {
  if (!canRestartLookupAfterFailure(operation, error)) return null;
  assertAllowed();
  // A completed submit event belongs to this task, not to a previous query.
  // Reattach only its reader and observe the original page. Never restart the
  // app or type again after a submitted query merely because RPC died.
  if (submitted) {
    if (resultRecoveryAttempted) return null;
    const reason = String(error?.message || error || "");
    if (!/HTTPConnectionPool\(|ReadTimeout|read timed out|poco_rpc_failed|worker (?:已退出|exited|terminated)/i.test(reason)) return null;
    await onRecovery({ mode: "reattach_result_only" });
    if (await stopWorker() !== true) throw new Error("lookup_old_worker_exit_unconfirmed");
    assertAllowed();
    return runWorker({ ...payload, operation: "query_resume", recoverUnexpectedPage: false,
      pageRecoveryStage: "reattach_result_only", observationOnlyResume: true,
      allowEmptyInputRecovery: false });
  }
  if (canReattachBeforeInput(error)) {
    await onRecovery({ mode: "reattach_before_input" });
    if (await stopWorker() !== true) throw new Error("lookup_old_worker_exit_unconfirmed");
    assertAllowed();
    let attached;
    try {
      attached = await runWorker({ ...payload, operation: "query", recoverUnexpectedPage: false,
        pageRecoveryStage: "reattach_before_input" });
    } catch (error) {
      if (!canReattachBeforeInput(error)) throw error;
      attached = { ok: false, error };
    }
    // A result, protected page or post-input failure belongs to that attempt.
    // Only another proven pre-input read timeout may use the old app recovery.
    if (attached?.ok || !canReattachBeforeInput(attached?.error)) return attached;
    assertAllowed();
  }
  await onRecovery({ mode: "restart_app" });
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
