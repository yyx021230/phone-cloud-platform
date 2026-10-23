// A missing page/result is not evidence that a physical phone is broken.
// Only a bounded, explicit transport/executor failure permits that inference.
export function lookupFailureDomain(job = {}) {
  const code = job.result?.errorCode;
  const reason = String(job.result?.diagnostic?.runnerReason || '');
  if (!['alipay_lookup_failed', 'alipay_lookup_result_unconfirmed'].includes(code)) return '';
  if (/^local_lookup_result_unconfirmed:(?:visual_network_busy|network_refresh_exhausted)$/.test(reason)) return 'network';
  // Lost input/foreground is a navigation failure, never an empty result frame.
  if (/(?:local_lookup_result_unconfirmed:(?:post_human_)?input_changed|local_lookup_result_unconfirmed:foreground_changed|poco_query_resume_state_mismatch:)/.test(reason)) return 'state';
  if (/\bdevice (?:offline|not found)|\bno devices\/emulators found|\bdevice unauthorized|HTTPConnectionPool\(|ConnectionResetError|ConnectionRefusedError|worker (?:exited|terminated|已退出)|verify_worker_adb_transport|local_lookup_result_unconfirmed:ocr_reader_(?:timeout|unavailable)/i.test(reason)) return 'device';
  return 'page';
}

// Evidence-specific terminal executor failure. A generic server_error alone
// cannot prove that replaying the original query is safe.
export function lookupKilledExecution(job={}) {
  return job.kind==='alipay_name_query' && job.status==='failed'
    && job.result?.errorCode==='task_failed' && job.result?.message==='server_error'
    && String(job.result?.uiSnapshot||'').trim()==='Killed';
}
