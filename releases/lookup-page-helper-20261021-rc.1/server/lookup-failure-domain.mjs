// A missing page/result is not evidence that a physical phone is broken.
// Only a bounded, explicit transport/executor failure permits that inference.
export function lookupFailureDomain(job = {}) {
  const code = job.result?.errorCode;
  const reason = String(job.result?.diagnostic?.runnerReason || '');
  if (!['alipay_lookup_failed', 'alipay_lookup_result_unconfirmed'].includes(code)) return '';
  if (/\bdevice (?:offline|not found)|\bno devices\/emulators found|\bdevice unauthorized|HTTPConnectionPool\(|ConnectionResetError|ConnectionRefusedError|worker (?:exited|terminated)|verify_worker_adb_transport|local_lookup_result_unconfirmed:ocr_reader_(?:timeout|unavailable)/i.test(reason)) return 'device';
  return 'page';
}
