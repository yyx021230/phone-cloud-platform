import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldAbortTask, canRetryLeaseFailure, evaluateNativeAcceptance} from './harness-policy.mjs';
test('technical probe and failed cleanup are reported to scheduler without global abort', () => {
  for (const code of ['alipay_lookup_failed','lookup_old_worker_exit_unconfirmed','alipay_human_verification_required','alipay_lookup_result_unconfirmed']) assert.equal(shouldAbortTask({code}), false);
});
test('unsafe ownership or identity boundary always aborts regardless of task code', () => {
  assert.equal(shouldAbortTask({code:'alipay_lookup_failed',unsafeTestBoundary:true}), true);
});
test('unknown HTTP 409 is not a proven busy race', () => {
  assert.equal(canRetryLeaseFailure({leaseFailure:true,http:409,code:'unclassified'}), false);
  assert.equal(canRetryLeaseFailure({leaseFailure:true,http:401,code:'unauthorized'}), false);
  assert.equal(canRetryLeaseFailure({leaseFailure:true,code:'occupied'}), true);
  assert.equal(canRetryLeaseFailure({leaseFailure:true,code:'channel_busy'}), true);
});
const fixture=()=>({ready:true,fullBusinessRecoveryPassed:true,stopped:true,results:[{status:'completed'},{status:'completed'}],finalCleanup:[{serial:'fixture-a',cleanupConfirmed:true,workerRemaining:false},{serial:'fixture-b',cleanupConfirmed:true,workerRemaining:false}]});
test('complete chain requires both business results and both actual cleanup proofs', () => assert.equal(evaluateNativeAcceptance(fixture(),['fixture-a','fixture-b']).passed,true));
test('logical stopped and normal child exit do not cover failed physical cleanup',()=>{
 const r=fixture();r.finalCleanup[1].cleanupConfirmed=false;assert.deepEqual(evaluateNativeAcceptance(r,['fixture-a','fixture-b']).reasons,['physical_cleanup_unconfirmed']);
});
test('prepare-only success or two normal queries cannot pass recovery acceptance',()=>{
 const r=fixture();delete r.fullBusinessRecoveryPassed;assert.equal(evaluateNativeAcceptance(r,['fixture-a','fixture-b']).passed,false);r.results=[];assert.ok(evaluateNativeAcceptance(r,['fixture-a','fixture-b']).reasons.includes('two_business_results_missing'));
});
test('duplicate or wrong-device cleanup cannot satisfy expected device set',()=>{
 const r=fixture();r.finalCleanup[1]={...r.finalCleanup[0]};assert.equal(evaluateNativeAcceptance(r,['fixture-a','fixture-b']).passed,false);
});
test('test error remains failure even when cleanup later succeeds',()=>{
 const r=fixture();r.testError='fixture ownership failure';assert.equal(evaluateNativeAcceptance(r,['fixture-a','fixture-b']).passed,false);
});
