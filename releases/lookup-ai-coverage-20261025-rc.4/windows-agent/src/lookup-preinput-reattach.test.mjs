import assert from 'node:assert/strict';import test from 'node:test';
import {restartLookupQueryOnce} from './lookup-page-recovery.mjs';
const timeout='poco_query_before_input_failed:ReadTimeout:HTTPConnectionPool read timed out. (read timeout=2.0)';
const payload={taskId:'original',phoneNumber:'13800138000',serial:'fixture',knownAccount:'account-A'};
function fixture(runWorker,extra={}){const calls=[],events=[];let stops=0;return {calls,events,get stops(){return stops;},run:()=>restartLookupQueryOnce({operation:'query',error:timeout,payload,onRecovery:async e=>events.push(e?.mode || "restart_app"),stopWorker:async()=>{stops++;return true;},runWorker:async p=>{calls.push(p);return runWorker(p,calls.length);},...extra})};}
test('real pre-input timeout preserves number/account and succeeds without app restart',async()=>{
 const f=fixture(async()=>({ok:true,realNameTailCharacter:'甲'}));assert.equal((await f.run()).ok,true);
 assert.equal(f.stops,1);assert.deepEqual(f.events,['reattach_before_input']);assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0],{...payload,operation:'query',recoverUnexpectedPage:false,pageRecoveryStage:'reattach_before_input'});
});
test('only a second proven pre-input timeout may escalate to one existing app recovery',async()=>{
 const f=fixture(async(p,n)=>n===1?{ok:false,error:timeout}:p.pageRecoveryStage==='restart_app'?{ok:true,appRecoveryStage:'app_restarted'}:{ok:true});
 assert.equal((await f.run()).ok,true);assert.deepEqual(f.calls.map(p=>p.pageRecoveryStage),['reattach_before_input','restart_app','continue_query']);
 assert.deepEqual(f.events,['reattach_before_input','restart_app']);assert.equal(f.stops,3);
});
test('protected and post-input outcomes from reattach cannot restart or duplicate input',async()=>{
 for(const error of ['poco_alipay_human_verification_required','poco_alipay_login_required','alipay_account_restriction_before_search:access_denied','device_not_online','local_lookup_result_unconfirmed:visual_card_not_proven','poco_query_result_channel_timeout_after_input:ReadTimeout','poco_query_before_input_failed:editableLength=4']){
  const f=fixture(async()=>({ok:false,error}));assert.equal((await f.run()).error,error);assert.equal(f.calls.length,1);assert.equal(f.stops,1);
 }
});
test('thrown cancellation and unknown post-input faults are not replayed',async()=>{
 for(const error of ['task_cancelled','poco_query_result_channel_timeout_after_input:ReadTimeout']){
  const f=fixture(async()=>{throw Error(error)});await assert.rejects(f.run(),new RegExp(error));assert.equal(f.calls.length,1);
 }
});
test('confirmed old-worker exit and cancellation fencing precede the new process',async()=>{
 let runs=0;const f=fixture(async()=>{runs++;return {ok:true}},{stopWorker:async()=>false});await assert.rejects(f.run(),/exit_unconfirmed/);assert.equal(runs,0);
 let allowed=true;const g=fixture(async()=>{runs++;return {ok:true}},{stopWorker:async()=>{allowed=false;return true;},assertAllowed:()=>{if(!allowed)throw Error('task_cancelled')}});await assert.rejects(g.run(),/task_cancelled/);assert.equal(runs,0);
});
test('untagged RPC, non-query, and protected-prefix failures cannot take the new path',async()=>{
 for(const error of ['poco_rpc_failed:ReadTimeout','poco_query_before_input_failed:invalid_phone_number:ReadTimeout','poco_query_before_input_failed:login_required:ReadTimeout']){
  const f=fixture(async p=>p.pageRecoveryStage==='restart_app'?{ok:true,appRecoveryStage:'app_restarted'}:{ok:true},{error});await f.run();assert.ok(!f.events.includes('reattach_before_input'));
 }
 const f=fixture(assert.fail,{operation:'query_resume'});assert.equal(await f.run(),null);
});
test('wrapped native RPC timeout remains narrowly eligible',async()=>{
 const f=fixture(async()=>({ok:true}),{error:'poco_query_before_input_failed:RuntimeError:poco_rpc_failed:HTTPConnectionPool read timed out. (read timeout=2.0)'});assert.equal((await f.run()).ok,true);assert.deepEqual(f.events,['reattach_before_input']);
});
