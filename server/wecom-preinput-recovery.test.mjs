import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryFixture as fixture} from './wecom-preinput-recovery-fixture.mjs';
import {createWecomCleanupService} from './wecom-cleanup-service.mjs';
import {createWecomCausalClock} from './wecom-causal-clock.mjs';

test('155-like original is preserved; distinct durable maintenance proof releases only that fence',async()=>{
 const f=fixture(),original=structuredClone([f.task,f.job,f.lock.physicalCleanup.hosts,f.lock.physicalCleanup.hostClosedAt]);
 const r=await f.start();assert.equal(f.service.canPick(f.getTask()),true);
 assert.equal(f.service.canPick({deviceId:f.lock.deviceId,adbSerial:f.binding.serial,type:'alipay_name_start'}),false);
 assert.equal(f.service.canPick({deviceId:'adb:other',adbSerial:'other',type:'alipay_name_start'}),true);
 f.pick();await f.challenge();const p=f.proof();assert.equal((await f.call('recovery-proof',p)).verified,true);
 assert.equal(f.service.pending(f.lock.deviceId),null);assert.equal(f.lock.releaseReason,'wecom_preinput_recovery_verified');
 assert.equal(f.getTask().status,'succeeded');assert.deepEqual([f.task,f.job,f.lock.physicalCleanup.hosts,f.lock.physicalCleanup.hostClosedAt],original);
 assert.equal(f.lock.physicalCleanup.verification,null);assert.equal(f.lock.physicalCleanup.proof,undefined);
 assert.equal(f.state.deviceLocks.length,2);assert.equal((await f.start()).reused,true);assert.equal((await f.call('recovery-proof',p)).reused,true);
 const restarted=createWecomCleanupService({...f.options,clock:createWecomCausalClock()});assert.equal((await restarted.recoveryHandle(f.binding.agentId,f.lock.lockId,'recovery-proof',p)).reused,true);
 assert.equal(r.taskId,f.getTask().taskId);
});
for(const [name,mutate]of [
 ['send mode',f=>f.task.payload.mode='send'],['missing previewOnly',f=>delete f.task.payload.previewOnly],['nonterminal task',f=>f.task.status='running'],
 ['unknown send',f=>delete f.task.result.sendStatus],['claimed',f=>f.job.wecomSendClaimAt='claimed'],['different failure',f=>f.job.result.previewCode='timeout'],
 ['registered hosts',f=>f.lock.physicalCleanup.hosts=[]],['original close',f=>f.lock.physicalCleanup.hostClosedAt='known'],['causal duty',f=>f.lock.physicalCleanup.causal={}],
 ['missing original row',f=>f.state.deviceLocks.pop()],['wrong original lock',f=>f.original.deviceId='adb:other'],['wrong agent',f=>f.task.agentId='other'],['wrong lock owner',f=>f.original.ownerUserId='other'],['wrong slot',f=>f.task.payload.androidUser=999],
 ['wrong serial',f=>f.task.adbSerial='other'],['wrong job',f=>f.job.windowsTaskId='other'],['missing capabilities',f=>delete f.state.windowsAgents[0].wecomRecoveryProtocol],
 ['stale capability',f=>f.step(30001)],['wrong current device',f=>f.state.devices[0].adb.serial='other'],['occupied phone',f=>f.block(true)],
 ['queued lookup',f=>f.state.windowsTasks.push({taskId:'lookup',type:'alipay_name_start',deviceId:f.lock.deviceId,status:'queued'})],
 ['alias task',f=>f.state.windowsTasks.push({taskId:'alias',deviceId:'adb:alias',adbSerial:f.binding.serial.toUpperCase(),status:'running'})],
 ['other active job',f=>f.state.automationJobs.push({jobId:'lookup',deviceId:f.lock.deviceId,status:'running'})]
])test('deny '+name+' without changing original fence',async()=>{const f=fixture();mutate(f);const before=JSON.stringify(f.state);await assert.rejects(f.start(),/wecom_cleanup_recovery/);assert.equal(JSON.stringify(f.state),before);assert.equal(f.lock.status,'cleanup_pending');});

test('fingerprint is stable after JSON key reorder and rejects original evidence drift',async()=>{
 const f=fixture(),r=f.request();f.task.result=Object.fromEntries(Object.entries(f.task.result).reverse());assert.equal(f.request().fingerprint,r.fingerprint);
 f.job.result.remarkSaveStatus='changed';await assert.rejects(f.service.recoveryStart(f.lock.lockId,r,'operator'),/context_changed/);
});
test('legacy admin-token empty owner remains factual; recovery still requires a named maintenance operator',async()=>{
 const f=fixture();f.job.userId=f.original.ownerUserId='';
 const request=f.request();await assert.rejects(f.service.recoveryStart(f.lock.lockId,request,''),/operator_required/);
 assert.equal(f.lock.status,'cleanup_pending');assert.equal((await f.start()).reused,false);
});
test('idempotent start does not renew a failed/expired generation',async()=>{
 const f=fixture(),r=f.request();await f.start();const t=f.pick();await f.service.status(t,{status:'failed',result:{errorCode:'wecom_cleanup_recovery_worker_present'}});
 f.step(130000);assert.equal((await f.service.recoveryStart(f.lock.lockId,r,'operator')).reused,true);assert.equal(f.service.canPick(t),false);
 await assert.rejects(f.service.recoveryStart(f.lock.lockId,{...r,requestId:'other'},'operator'),/attempt_exists/);assert.equal(f.state.windowsTasks.length,2);
});
for(const [label,change]of [
 ['wrong machine',p=>p.observer.machineId='b'.repeat(64)],['old producer alive',p=>p.observer={...p.retiredProducer}],['foreign target',p=>p.binding={...p.binding,serial:'other'}],
 ['one frame',p=>p.snapshots.pop()],['residual forward',p=>p.snapshots[1].serialForwardCount=1],['live workers',p=>p.snapshots[0].wecomWorkersAbsent=false],
 ['producer unknown',p=>p.snapshots[1].producerRetired=false],['equal times',p=>p.snapshots[1].elapsedMs=100],['extra cleanup field',p=>p.cleanupConfirmed=true]
])test('proof denies '+label,async()=>{const f=fixture();await f.start();f.pick();await f.challenge();const p=f.proof();change(p);await assert.rejects(f.call('recovery-proof',p),/wecom_cleanup/);assert.equal(f.lock.status,'cleanup_pending');});

test('fresh challenge, same task, current epoch, no conflicting work are all required',async()=>{
 const f=fixture();await f.start();f.pick();await f.challenge();const p=f.proof();
 await assert.rejects(f.service.status(f.getTask(),{status:'succeeded'}),/proof_required/);
 f.block(true);await assert.rejects(f.call('recovery-proof',p),/lease_lost/);f.block(false);f.step(3001);await assert.rejects(f.call('recovery-proof',p),/causal/);
 const restarted=createWecomCleanupService({...f.options,clock:createWecomCausalClock()});assert.equal(restarted.canPick(f.getTask()),false);
 assert.equal(restarted.recoveryLease(f.binding.agentId,f.lock.lockId,f.fields()).valid,false);assert.equal(f.lock.status,'cleanup_pending');
});
test('storage failure and concurrent checkpoint never expose a speculative release',async()=>{
 let resolve,entered;const enteredPromise=new Promise(r=>entered=r);let block=false;
 const f=fixture({persist:async()=>{if(block){entered();await new Promise(r=>resolve=r);throw Error('synthetic failure');}}});
 await f.start();f.pick();await f.challenge();const p=f.proof();block=true;const saving=f.call('recovery-proof',p);await enteredPromise;
 assert.equal(f.service.canPick({type:'alipay_name_start',deviceId:f.lock.deviceId,adbSerial:f.binding.serial}),false);
 assert.equal(f.service.canPick({type:'alipay_name_start',deviceId:'adb:other',adbSerial:'other'}),true);
 const checkpoint=f.service.checkpoint(structuredClone(f.state));assert.equal(checkpoint.deviceLocks.find(l=>l.lockId===f.lock.lockId).status,'cleanup_pending');
 resolve();await assert.rejects(saving,/storage_unavailable/);assert.equal(f.lock.status,'cleanup_pending');assert.equal(f.getTask().status,'running');
 block=false;assert.equal((await f.call('recovery-proof',p)).verified,true);
});


function configFailureFixture(){
 const f=fixture(),producer=f.request().retiredProducer,d=f.lock.physicalCleanup,at=d.originalTerminalAt;
 for(const row of [f.task,f.job])Object.assign(row.result,{previewCode:'invalid_preview_config',message:'invalid_preview_config',diagnostic:{wecomExecution:{phase:'configuration',failurePhase:'configuration',elapsedMs:0}}});
 d.hosts=[{role:'reader',...producer,createdAt:at}];d.hostClosedAt=at;d.phase='awaiting_verification';
 d.causal={protocol:'wecom-causal-v1',bootstrap:{protocol:'wecom-causal-v1',bindingNonce:f.binding.nonce,pipeNonce:'a'.repeat(48)}};
 const ticket={protocol:'wecom-causal-v1',epoch:'old-epoch',leaseId:'old-verification',purpose:'verification'};
 d.verification={verificationTaskId:'old-verify',verificationId:'old-id',verificationNonce:'old-nonce',issuedAt:at,expiresAt:at,pickedAt:at,causalLease:ticket};
 const oldVerify={taskId:'old-verify',type:'wecom_cleanup_verify',status:'failed',deviceId:f.binding.deviceId,adbSerial:f.binding.serial,agentId:f.binding.agentId,
  payload:{physicalCleanup:f.binding,verificationTaskId:'old-verify',verificationId:'old-id',verificationNonce:'old-nonce',causalLease:ticket},result:{errorCode:'wecom_cleanup_verify_timeout'}};
 f.state.windowsTasks.push(oldVerify);return {...f,oldVerify,producer};
}

test('registered configuration rejection can receive a separate maintenance proof, preserving the old timeout',async()=>{
 const f=configFailureFixture(),before=structuredClone([f.task,f.job,f.oldVerify,f.lock.physicalCleanup.hosts,f.lock.physicalCleanup.verification]);
 const proposal=f.service.recoveryGet(f.lock.lockId);assert.equal(proposal.requiresAgentReload,false);assert.deepEqual(proposal.retiredProducer,f.producer);
 await f.start();f.pick();await f.challenge();assert.equal((await f.call('recovery-proof',f.proof())).verified,true);
 assert.equal(f.lock.status,'released');assert.deepEqual([f.task,f.job,f.oldVerify,f.lock.physicalCleanup.hosts,f.lock.physicalCleanup.verification],before);
 assert.equal(f.getTask().status,'succeeded');assert.equal(f.oldVerify.status,'failed');assert.equal(f.state.windowsTasks.length,3);
});
for(const [name,change]of [
 ['different failure',f=>f.task.result.previewCode='timeout'],['UI phase',f=>f.job.result.diagnostic.wecomExecution.phase='recipient_search'],
 ['nonzero elapsed',f=>f.task.result.diagnostic.wecomExecution.elapsedMs=1],['send claimed',f=>f.task.result.sendClaimed=true],
 ['unclosed host',f=>f.lock.physicalCleanup.hostClosedAt=''],['bad host',f=>f.lock.physicalCleanup.hosts[0].creationToken='unknown'],
 ['missing bootstrap binding',f=>delete f.lock.physicalCleanup.causal.bootstrap.bindingNonce],['proof already present',f=>f.lock.physicalCleanup.proof={}],
 ['missing failed verifier',f=>f.state.windowsTasks.pop()],['running verifier',f=>f.oldVerify.status='running'],
 ['other verify failure',f=>f.oldVerify.result.errorCode='proof_invalid'],['wrong verifier device',f=>f.oldVerify.deviceId='adb:other'],
 ['different original binding',f=>f.oldVerify.payload.physicalCleanup={...f.binding,originalTaskId:'other'}],
 ['wrong verifier nonce',f=>f.oldVerify.payload.verificationNonce='other'],['wrong verifier authority',f=>f.oldVerify.payload.causalLease={...f.oldVerify.payload.causalLease,epoch:'other'}]
])test('registered configuration recovery denies '+name+' without releasing the fence',async()=>{
 const f=configFailureFixture();change(f);const before=structuredClone(f.state);await assert.rejects(f.start(),/wecom_cleanup_recovery/);assert.deepEqual(f.state,before);
});
test('registered reader identity is pinned by the server, not chosen by the caller',async()=>{
 const f=configFailureFixture(),request=f.request();request.retiredProducer={...request.retiredProducer,pid:999};
 await assert.rejects(f.service.recoveryStart(f.lock.lockId,request,'operator'),/producer_invalid/);assert.equal(f.lock.status,'cleanup_pending');
});


async function failedMaintenance(f,code='wecom_cleanup_recovery_worker_present'){
 await f.start();f.pick();await f.challenge();const proof=f.proof(),task=f.getTask(),request=f.request();
 await f.service.status(task,{status:'failed',result:{errorCode:code}});return {task,proof,request};
}
test('explicit named maintenance retry creates fresh authority, preserves the failed attempt and old-request ACK',async()=>{
 const f=fixture(),old=await failedMaintenance(f),before=structuredClone(old.task);
 const request={...f.request(),requestId:'retry-one',retryOf:old.task.taskId};
 assert.equal(f.service.recoveryGet(f.lock.lockId).canRetry,true);
 const accepted=await f.service.recoveryStart(f.lock.lockId,request,'operator');assert.notEqual(accepted.taskId,old.task.taskId);
 assert.deepEqual(old.task,before);assert.equal(f.lock.physicalCleanup.recoveryHistory.length,1);
 assert.equal((await f.service.recoveryStart(f.lock.lockId,old.request,'operator')).taskId,old.task.taskId);
 assert.equal((await f.service.recoveryStart(f.lock.lockId,request,'operator')).taskId,accepted.taskId);assert.equal(f.state.windowsTasks.length,3);
 f.pick();await f.challenge();await assert.rejects(f.call('recovery-proof',old.proof),/lease_lost/);
 assert.equal((await f.call('recovery-proof',f.proof())).verified,true);assert.equal(f.lock.status,'released');assert.deepEqual(old.task,before);
 assert.equal((await f.service.recoveryStart(f.lock.lockId,old.request,'operator')).verified,false);
});
for(const[name,change]of[
 ['wrong previous attempt',(f,r)=>r.retryOf='other'],['wrong operator',(f,r)=>r.operator='other'],
 ['changed original',(f,r)=>f.job.result.remarkSaveStatus='changed'],['unclassified failure',(f,r)=>f.getTask().result.errorCode='unclassified'],
 ['active attempt',(f,r)=>f.getTask().status='running'],['proof present',(f,r)=>f.lock.physicalCleanup.recovery.proof={}]
])test('explicit retry rejects '+name,async()=>{
 const f=fixture(),old=await failedMaintenance(f),request={...f.request(),requestId:'retry-one',retryOf:old.task.taskId};change(f,request);
 const operator=request.operator||'operator';delete request.operator;const before=structuredClone(f.state);
 await assert.rejects(f.service.recoveryStart(f.lock.lockId,request,operator),/wecom_cleanup_recovery/);assert.deepEqual(f.state,before);
});
test('maintenance attempts are capped at five and never restart automatically',async()=>{
 const f=fixture();await failedMaintenance(f);
 for(let i=1;i<5;i++){
  const old=f.getTask();await f.service.recoveryStart(f.lock.lockId,{...f.request(),requestId:'retry-'+i,retryOf:old.taskId},'operator');
  f.pick();await f.service.status(f.getTask(),{status:'failed',result:{errorCode:'wecom_cleanup_verify_timeout'}});
 }
 assert.equal(f.lock.physicalCleanup.recoveryHistory.length,4);assert.equal(f.service.recoveryGet(f.lock.lockId).canRetry,false);
 await assert.rejects(f.service.recoveryStart(f.lock.lockId,{...f.request(),requestId:'retry-extra',retryOf:f.getTask().taskId},'operator'),/retry_not_allowed/);
 assert.equal(f.state.windowsTasks.length,6);
});


test('explicit retry after an issued challenge keeps failed invalid proof immutable',async()=>{
 const f=fixture(),old=await failedMaintenance(f,'wecom_cleanup_recovery_invalid'),before=structuredClone(old.task);
 assert.equal(f.service.recoveryGet(f.lock.lockId).canRetry,true);
 await f.service.recoveryStart(f.lock.lockId,{...f.request(),requestId:'retry-invalid',retryOf:old.task.taskId},'operator');
 f.pick();await f.challenge();assert.equal((await f.call('recovery-proof',f.proof())).verified,true);assert.deepEqual(old.task,before);
});
for(const malformed of [undefined,{}, {protocol:'other',epoch:'old',verificationLeaseId:'old',challengeId:'id'}])test('invalid maintenance without its issued challenge cannot retry '+JSON.stringify(malformed),async()=>{
 const f=fixture(),old=await failedMaintenance(f,'wecom_cleanup_recovery_invalid');f.lock.physicalCleanup.recovery.challenge=malformed;
 assert.equal(f.service.recoveryGet(f.lock.lockId).canRetry,false);
 await assert.rejects(f.service.recoveryStart(f.lock.lockId,{...f.request(),requestId:'retry-invalid',retryOf:old.task.taskId},'operator'),/retry_not_allowed/);
});
