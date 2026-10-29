// Legacy XML exhaustion is a technical result-reading failure, never proof
// of no name. Require the runner-owned code and exact recovery prefix.
export function lookupLegacyResultMissing(job={}) {
  return job.kind==='alipay_name_query' && job.result?.errorCode==='alipay_person_result_not_found'
    && /^alipay_lookup_failed_after_recovery:alipay_person_result_not_found(?::|$)/.test(String(job.result?.diagnostic?.runnerReason||''));
}
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
  if(lookupLegacyResultMissing(job))return 'legacy_person_result_missing';
  if(!['alipay_lookup_failed','alipay_lookup_result_unconfirmed'].includes(job.result?.errorCode))return '';
  const reason=lookupFailureReason(job);
  return /^local_lookup_result_unconfirmed:(?:observation_budget_exhausted|visual_card_not_proven|visual_card_changed|ocr_reader_timeout|ocr_reader_unavailable)$/.test(reason)?reason:'';
}

// A missing page/result is not evidence that a physical phone is broken.
// Only a bounded, explicit transport/executor failure permits that inference.
export function lookupFailureDomain(job = {}) {
  if(lookupLegacyResultMissing(job))return 'page';
  const code = job.result?.errorCode;
  const reason = lookupFailureReason(job);
  if (code === 'alipay_lookup_failed' && (reason === 'lookup_worker_capacity_reached'
    || /^Airtest\/Poco 常驻 worker 已达到上限 (?:\d+|#+)，当前均在执行任务$/.test(reason))) return 'capacity';
  // A timed-out package-manager command is transport/preflight evidence,
  // not a missing screen selector and not proof of an account restriction.
  if (code === 'task_failed' && /^package_manager_unresponsive:/.test(String(job.result?.message||''))) return 'device';
  // Agent preflight can fail before a Python diagnostic exists (191). Match
  // explicit ADB evidence only; a generic task_failed remains unknown.
  if (code === 'task_failed' && /(?:^|\n)ADB 设备未连接：[^\r\n]+/.test(String(job.result?.message||''))
    && /\berror: device ['"][^'"\r\n]+['"] (?:not found|offline|unauthorized)\b/.test(String(job.result?.message||''))) return 'device';
  if (!['alipay_lookup_failed', 'alipay_lookup_result_unconfirmed'].includes(code)) return '';
  if (/^lookup_(?:old|restart|prepare)_worker_exit_unconfirmed$/.test(reason)
    || reason === 'lookup_reader_cleanup_unconfirmed') return 'device';
  if (/^poco_worker_bootstrap_failed:adb_probe:(?:timeout|device_unavailable|command_failed)$/.test(reason)) return 'device';
  // A local result reader failure can use the exact terminal screenshot; it
  // does not prove the device or its ADB transport is unavailable.
  if (lookupTerminalResultReason(job)) return 'page';
  // The runner emits this only after a nonzero ADB observation exit and
  // its bounded read retries. Empty rc=0 reads remain ambiguous.
  if (reason === 'local_lookup_result_unconfirmed:adb_read_unavailable') return 'device';
  if (/^local_lookup_result_unconfirmed:(?:visual_network_busy|network_refresh_exhausted|network_refresh_unconfirmed)$/.test(reason)) return 'network';
  // Lost input/foreground is a navigation failure, never an empty result frame.
  if (/(?:local_lookup_result_unconfirmed:(?:post_human_)?input_changed|local_lookup_result_unconfirmed:foreground_changed|poco_query_resume_state_mismatch:)/.test(reason)) return 'state';
  if (/\bdevice (?:['"][^'"\r\n]+['"] )?(?:offline|not found|unauthorized)\b|\bno devices\/emulators found|HTTPConnectionPool\(|ConnectionResetError|ConnectionRefusedError|worker (?:exited|terminated|已退出)|verify_worker_adb_transport/i.test(reason)) return 'device';
  // Python TimeoutExpired includes the exact subprocess argv. A screenshot
  // transport timeout is not a result/OCR timeout and cannot feed result AI.
  if (/\bexec-out\b[^\r\n]*\bscreencap\b[^\r\n]*timed out after/i.test(reason)) return 'device';
  return 'page';
}

// Evidence-specific terminal executor failure. A generic server_error alone
// cannot prove that replaying the original query is safe.
export function lookupKilledExecution(job={}) {
  return job.kind==='alipay_name_query' && job.status==='failed'
    && job.result?.errorCode==='task_failed' && job.result?.message==='server_error'
    && String(job.result?.uiSnapshot||'').trim()==='Killed';
}
