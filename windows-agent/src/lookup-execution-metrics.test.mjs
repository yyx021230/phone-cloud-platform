import {lookupReaderCleanupFailure,requireConfirmedLookupCleanup} from './lookup-cleanup-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measureLookupExecution } from './lookup-execution-metrics.mjs';
import { runLookupWithAccountPolicy } from './lookup-account-policy.mjs';
import { restartLookupQueryOnce } from './lookup-page-recovery.mjs';
import { collectLookupTrace, isAutomaticLookupResume } from './lookup-recovery-trace.mjs';
const source = fs.readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const fn = name => source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))[0];
const failure = new Function(fn('taskFailureResult')+';return taskFailureResult;')();
const compact = new Function('compactEventDetail', fn('compactTaskResultForStatus')+';return compactTaskResultForStatus;')(x=>x);
function fixture(sequence, cleanup = true) {
  let tick = 100, calls = [];
  const deps = {lookupReaderCleanupFailure,requireConfirmedLookupCleanup, measureLookupExecution: execute=>measureLookupExecution(execute,()=>tick), runLookupWithAccountPolicy,
    screenControlledSerials:new Set(), config:{}, fileExists:async()=>true, assertAdbDeviceOnlineFast:async()=>{},
    isPackageInstalled:async()=>true, taskEvent:async()=>{}, touchAirtestLookupWarmLease:()=>{},
    collectLookupTrace,isAutomaticLookupResume,replayAirtestEvents:async()=>{},restartLookupQueryOnce,
    isAutomationTaskCancellation:e=>e.code==='automation_task_cancelled',
    classifyAlipayNameLookupFailure:reason=>({code:'alipay_lookup_failed',message:'failed',runnerReason:reason}),
    alipayAccountSwitchReasonFromError:()=>'',shouldFallbackAlipayPocoFailure:()=>false,
    stopAirtestWorker:async()=>{tick+=7;return cleanup;},
    runXhsAirtestPocoWorker:async(payload,options)=>{calls.push(payload);tick+=100;return sequence(calls.length,payload,options);}
  };
  const execute = new Function(...Object.keys(deps),fn('taskAlipayNameLookup')+'\n'+fn('taskAlipayNameLookupWithAccounts')+';return taskAlipayNameLookupWithAccounts;')(...Object.values(deps));
  return {execute:()=>execute({taskId:'t',type:'alipay_name_query',adbSerial:'synthetic',payload:{phoneNumber:'synthetic'}}),calls};
}
test('actual query retries count reader rebuild and result resume, without repeated input or app restart',async()=>{
  const f=fixture(async(n,p,o)=>{if(n===1)await o.onEvent({step:'submit_search'});return n<3?{ok:false,error:'poco_query_result_channel_timeout_after_input'}:{ok:true,realNameTailCharacter:'名'};});
  const r=await f.execute();assert.equal(r.durationMs,314);
  assert.deepEqual(r.diagnostic.lookupExecution,{version:1,scope:'agent_command',durationMs:314,readerRebuildAttempts:2,appRestartAttempts:0,resultResumeAttempts:2});
  assert.deepEqual(f.calls.map(p=>p.operation),['query','query_resume','query_resume']);
  assert.ok(f.calls.slice(1).every(p=>p.observationOnlyResume&&!p.allowEmptyInputRecovery));
});
test('cleanup failure retains attempt and measured elapsed through failure transport, never counts unstarted resume',async()=>{
  const f=fixture(()=>({ok:false,error:'poco_query_result_channel_timeout_after_input'}),false);
  await assert.rejects(f.execute(),e=>{const r=compact(failure(e));assert.equal(r.durationMs,107);assert.equal(r.diagnostic.lookupExecution.readerRebuildAttempts,1);assert.equal(r.diagnostic.lookupExecution.resultResumeAttempts,0);return true;});
  assert.equal(f.calls.length,1);
});
test('pre-input attach then app recovery counts each reader attempt separately from app restart',async()=>{
  const f=fixture(n=>{if(n<=2)throw Error('poco_query_before_input_failed:ReadTimeout');return n===3?{ok:true,appRecoveryStage:'app_restarted'}:{ok:true,notFound:true};});
  const r=await f.execute();assert.equal(r.durationMs,421);assert.equal(r.diagnostic.lookupExecution.readerRebuildAttempts,3);assert.equal(r.diagnostic.lookupExecution.appRestartAttempts,1);assert.equal(r.diagnostic.lookupExecution.resultResumeAttempts,0);
});
test('cancelled execution retains measurement without treating cancellation as recovery',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('cancelled'),{code:'automation_task_cancelled'});});
  await assert.rejects(f.execute(),e=>{assert.equal(failure(e).durationMs,100);assert.equal(e.diagnostic.lookupExecution.readerRebuildAttempts,0);return true;});
});
test('account policy measurement includes multiple substeps rather than last substep duration',async()=>{
  let time=0;const r=await measureLookupExecution(async counts=>{time+=40;counts.readerRebuildAttempts++;time+=80;return {durationMs:80,diagnostic:{code:'kept'}};},()=>time);
  assert.equal(r.durationMs,120);assert.equal(r.diagnostic.code,'kept');assert.equal(r.diagnostic.lookupExecution.readerRebuildAttempts,1);
});
test('missing, null, blank, negative and boolean duration stays unknown while numeric zero is valid',()=>{
  for(const value of [undefined,null,'',' ',false,true,-1,Infinity,NaN])for(const key of ['durationMs','wallMs','timeoutSeconds'])assert.equal(compact({[key]:value})[key],null);
  assert.equal(compact({durationMs:0}).durationMs,0);assert.equal(compact({durationMs:'125'}).durationMs,125);
});
for(const mode of ['probe','idle','both','probe_failed'])test('actual worker '+mode+' recycle is counted once at each action across task wrapper',async()=>{
  let probes=0,recycles=0;
  const worker={lastUsedAt:['idle','both'].includes(mode)?Date.now()-1000000:Date.now(),enqueue:async()=>({ok:true,notFound:true,log:[]})};
  const workerDeps={getAirtestWorker:async()=>worker,delay:()=>new Promise(()=>{}),
    probeAirtestWorker:async()=>{probes++;if(mode==='probe_failed'||mode!=='idle'&&probes===1)throw Error('synthetic probe failure');},
    recycleAirtestWorker:async()=>{recycles++;return worker;},log:()=>{},lookupReaderStopReason:(_p,r)=>r};
  const runWorker=new Function(...Object.keys(workerDeps),fn('runXhsAirtestPocoWorker')+';return runXhsAirtestPocoWorker;')(...Object.values(workerDeps));
  const deps={lookupReaderCleanupFailure,requireConfirmedLookupCleanup,config:{},fileExists:async()=>true,assertAdbDeviceOnlineFast:async()=>{},isPackageInstalled:async()=>true,
    taskEvent:async()=>{},collectLookupTrace,replayAirtestEvents:async()=>{},touchAirtestLookupWarmLease:()=>{},runXhsAirtestPocoWorker:runWorker,
    isAutomationTaskCancellation:()=>false,restartLookupQueryOnce:async()=>null,alipayAccountSwitchReasonFromError:()=>'',shouldFallbackAlipayPocoFailure:()=>false,
    classifyAlipayNameLookupFailure:r=>({code:'probe_failed',message:r})};
  const task=new Function(...Object.keys(deps),fn('taskAlipayNameLookup')+';return taskAlipayNameLookup;')(...Object.values(deps));
  let result;
  try{result=await measureLookupExecution(m=>task({type:'alipay_name_query',taskId:'t',adbSerial:'synthetic',payload:{}},{lookupMetrics:m}));}
  catch(e){assert.equal(mode,'probe_failed');result=failure(e);}
  assert.equal(recycles,mode==='both'?2:1);assert.equal(result.diagnostic.lookupExecution.readerRebuildAttempts,recycles);
});
test('other workflows ignore lookup-only rebuild hook and keep existing worker sequence',async()=>{
  let called=0,recycles=0;
  const worker={lastUsedAt:Date.now()-100000,enqueue:async()=>({ok:true})};
  const deps={getAirtestWorker:async()=>worker,probeAirtestWorker:async()=>{},recycleAirtestWorker:async()=>{recycles++;return worker;},log:()=>{},lookupReaderStopReason:(_p,r)=>r};
  const run=new Function(...Object.keys(deps),fn('runXhsAirtestPocoWorker')+';return runXhsAirtestPocoWorker;')(...Object.values(deps));
  await run({serial:'synthetic',workflow:'xhs_qr'},{onReaderRebuild:()=>called++});assert.equal(recycles,1);assert.equal(called,0);
});
