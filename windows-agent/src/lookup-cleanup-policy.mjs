// Only executor-owned cleanup markers can fence a driver transition. Never
// promote arbitrary quoted ADB output or historical diagnostics to proof.
const CODES = new Set([
  'lookup_reader_cleanup_unconfirmed', 'lookup_reader_forward_cleanup_unconfirmed',
  'lookup_old_worker_exit_unconfirmed', 'lookup_restart_worker_exit_unconfirmed',
  'lookup_prepare_worker_exit_unconfirmed'
]);
const WRAPPER = /^(?:poco_query_page_recovery_failed|poco_query_resume_failed|poco_query_resume_observation_failed):/;

export function lookupReaderCleanupFailure(error) {
  if (CODES.has(error?.code)) return error.code;
  let reason = String(error?.message || error || '');
  for (let depth = 0; depth <= 3; depth++) {
    if (CODES.has(reason)) return reason;
    const next = reason.replace(WRAPPER, '');
    if (next === reason) break;
    reason = next;
  }
  return '';
}

export async function requireConfirmedLookupCleanup(stop) {
  let cause;
  try {
    if (await stop() === true) return true;
  } catch (error) {
    if (['automation_task_cancelled','screen_control_priority'].includes(error?.code)
      || ['automation_task_cancelled','screen_control_priority'].includes(error?.message)) throw error;
    cause = error;
  }
  const code = lookupReaderCleanupFailure(cause) || 'lookup_reader_cleanup_unconfirmed';
  throw Object.assign(new Error(code, {cause}), {code});
}
