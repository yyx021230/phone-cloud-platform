// Unwrap only executor-owned recovery prefixes; never substring-match an
// unrelated error into a terminal result or erase input/foreground guards.
export function lookupFailureReason(job={}) {
  let reason=String(job.result?.diagnostic?.runnerReason||'');
  for(let i=0;i<3;i++){
    const next=reason.replace(/^(?:poco_query_page_recovery_failed|poco_query_resume_failed|poco_query_resume_observation_failed):/,'');
    if(next===reason)break;reason=next;
  }
  return reason;
}
export function lookupTerminalResultReason(job={}) {
  if(!['alipay_lookup_failed','alipay_lookup_result_unconfirmed'].includes(job.result?.errorCode))return '';
  const reason=lookupFailureReason(job);
  return /^local_lookup_result_unconfirmed:(?:observation_budget_exhausted|visual_card_not_proven|visual_card_changed|ocr_reader_timeout|ocr_reader_unavailable)$/.test(reason)?reason:'';
}

// A missing page/result is not evidence that a physical phone is broken.
// Only a bounded, explicit transport/executor failure permits that inference.
export function lookupFailureDomain(job = {}) {
  const code = job.result?.errorCode;
  const reason = lookupFailureReason(job);
  if (!['alipay_lookup_failed', 'alipay_lookup_result_unconfirmed'].includes(code)) return '';
  // A local result reader failure can use the exact terminal screenshot; it
  // does not prove the device or its ADB transport is unavailable.
  if (lookupTerminalResultReason(job)) return 'page';
  if (/^local_lookup_result_unconfirmed:(?:visual_network_busy|network_refresh_exhausted)$/.test(reason)) return 'network';
  // Lost input/foreground is a navigation failure, never an empty result frame.
  if (/(?:local_lookup_result_unconfirmed:(?:post_human_)?input_changed|local_lookup_result_unconfirmed:foreground_changed|poco_query_resume_state_mismatch:)/.test(reason)) return 'state';
  if (/\bdevice (?:offline|not found)|\bno devices\/emulators found|\bdevice unauthorized|HTTPConnectionPool\(|ConnectionResetError|ConnectionRefusedError|worker (?:exited|terminated|已退出)|verify_worker_adb_transport/i.test(reason)) return 'device';
  return 'page';
}

// Evidence-specific terminal executor failure. A generic server_error alone
// cannot prove that replaying the original query is safe.
export function lookupKilledExecution(job={}) {
  return job.kind==='alipay_name_query' && job.status==='failed'
    && job.result?.errorCode==='task_failed' && job.result?.message==='server_error'
    && String(job.result?.uiSnapshot||'').trim()==='Killed';
}
