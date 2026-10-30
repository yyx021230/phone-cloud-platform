import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupReaderCleanupFailure,requireConfirmedLookupCleanup} from './lookup-cleanup-policy.mjs';
import {shouldFallbackAlipayPocoFailure} from './alipay-poco-fallback-policy.mjs';
import {canRestartLookupAfterFailure} from './lookup-page-recovery.mjs';
import {lookupFailureDomain} from '../../server/lookup-failure-domain.mjs';

for (const code of ['lookup_reader_cleanup_unconfirmed','lookup_reader_forward_cleanup_unconfirmed',
  'lookup_old_worker_exit_unconfirmed','lookup_restart_worker_exit_unconfirmed','lookup_prepare_worker_exit_unconfirmed']) {
  test('all driver gates and cloud agree on '+code,()=>{
    for(const error of [code,Error(code),{code,message:'paused'},
      Error('poco_query_page_recovery_failed:poco_query_resume_failed:'+code)]) {
      assert.equal(lookupReaderCleanupFailure(error),code);
      assert.equal(shouldFallbackAlipayPocoFailure(error),false);
      assert.equal(canRestartLookupAfterFailure('query',error),false);
    }
    assert.equal(lookupFailureDomain({result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:code}}}),'device');
  });
}
test('unrelated output cannot become a cleanup marker',()=>{
  for(const error of [null,{},'quoted lookup_reader_cleanup_unconfirmed',
    'lookup_reader_cleanup_unconfirmed:untrusted suffix','unexpected:lookup_reader_cleanup_unconfirmed',
    {message:'ordinary page failure',diagnostic:{runnerReason:'lookup_reader_cleanup_unconfirmed'}}]) {
    assert.equal(lookupReaderCleanupFailure(error),'');
  }
  assert.equal(shouldFallbackAlipayPocoFailure(Error('poco_selector_missing:search input')),true);
});
test('bounded recovery wrappers cannot unwrap arbitrary nesting',()=>{
  const code='lookup_reader_cleanup_unconfirmed';
  assert.equal(lookupReaderCleanupFailure(Error('poco_query_resume_failed:'.repeat(3)+code)),code);
  assert.equal(lookupReaderCleanupFailure(Error('poco_query_resume_failed:'.repeat(4)+code)),'');
});
test('cleanup retry requires an exact true acknowledgement',async()=>{
  for(const value of [false,undefined,null,1,'true',{}])await assert.rejects(requireConfirmedLookupCleanup(async()=>value),{code:'lookup_reader_cleanup_unconfirmed'});
  assert.equal(await requireConfirmedLookupCleanup(async()=>true),true);
});
test('cleanup retry preserves cancellation and exact typed cause without copying private message',async()=>{
  for(const code of ['automation_task_cancelled','screen_control_priority']){
    const original=Object.assign(Error('cancelled'),{code});
    await assert.rejects(requireConfirmedLookupCleanup(async()=>{throw original;}),error=>{assert.equal(error,original);return true;});
  }
  const cause=Object.assign(Error('private diagnostic'),{code:'lookup_reader_forward_cleanup_unconfirmed'});
  await assert.rejects(requireConfirmedLookupCleanup(async()=>{throw cause;}),error=>{
    assert.equal(error.code,cause.code);assert.equal(error.message,cause.code);assert.equal(error.cause,cause);return true;
  });
});
