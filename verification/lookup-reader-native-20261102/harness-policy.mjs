// Test harness acceptance only. Does not change production task classification.
export function shouldAbortTask(error) {
  return error?.unsafeTestBoundary === true;
}
export function canRetryLeaseFailure(marker) {
  return marker?.leaseFailure === true && ['occupied', 'channel_busy'].includes(marker.code);
}
export function evaluateNativeAcceptance(receipt, expectedSerials) {
  const reasons = [];
  if (!receipt.ready) reasons.push('readiness_not_completed');
  if (receipt.fullBusinessRecoveryPassed !== true) reasons.push('business_recovery_not_completed');
  if (receipt.results?.length !== 2 || receipt.results.some(x => x.status !== 'completed')) reasons.push('two_business_results_missing');
  if (receipt.stopped !== true) reasons.push('round_not_stopped');
  if (receipt.testError) reasons.push('test_error');
  const proofs = receipt.finalCleanup || [];
  if (proofs.length !== expectedSerials.length || new Set(proofs.map(x => x.serial)).size !== expectedSerials.length || expectedSerials.some(serial => !proofs.some(x => x.serial === serial && x.cleanupConfirmed === true && x.workerRemaining === false))) reasons.push('physical_cleanup_unconfirmed');
  return {passed: reasons.length === 0, reasons};
}
