// Explicit maintenance recovery for a terminal PREVIEW which failed before
// UI configuration: legacy missing host or a registered configuration rejection.
// Fresh maintenance evidence never replaces the original failure or PID proof.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {WECOM_PACKAGES,isWecomCleanupPending,validateWecomHosts} from './wecom-physical-cleanup.mjs';
export const PREINPUT_RECOVERY='wecom-preinput-recovery-v1';
export const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const recoveryFail=code=>{throw Object.assign(new Error('wecom_cleanup_recovery_'+code),{statusCode:409});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function producerRef(v){
  if(!exact(v,['pid','creationToken','machineId'])||!Number.isSafeInteger(v.pid)||v.pid<=0||v.pid>0xffffffff
    ||typeof v.creationToken!=='string'||!/^0x1\.[0-9a-f]{13}p\+\d{1,4}$/.test(v.creationToken)
    ||typeof v.machineId!=='string'||!/^[a-f0-9]{64}$/.test(v.machineId))recoveryFail('producer_invalid');
  return structuredClone(v);
}
// A configuration rejection never entered UI. A timed-out cleanup remains a
// failed original attempt: maintenance obtains fresh, separate evidence only.
function registeredConfigFailure(state,d,task,job){
  const v=d.verification,verify=state.windowsTasks.find(t=>t.taskId===v?.verificationTaskId);
  if(![task,job].every(x=>x.result?.previewStatus==='blocked'&&x.result?.previewCode==='invalid_preview_config'
      &&x.result?.diagnostic?.wecomExecution?.phase==='configuration'
      &&x.result?.diagnostic?.wecomExecution?.failurePhase==='configuration'
      &&x.result?.diagnostic?.wecomExecution?.elapsedMs===0)
    ||d.causal?.protocol!=='wecom-causal-v1'||d.causal?.bootstrap?.bindingNonce!==d.binding.nonce
    ||!Number.isFinite(Date.parse(d.hostClosedAt))||d.proof
    ||!verify||verify.status!=='failed'||verify.type!=='wecom_cleanup_verify'
    ||verify.result?.errorCode!=='wecom_cleanup_verify_timeout'
    ||verify.agentId!==d.binding.agentId||verify.deviceId!==d.binding.deviceId||verify.adbSerial!==d.binding.serial
    ||!equal(verify.payload?.physicalCleanup,d.binding)
    ||!['verificationId','verificationNonce','verificationTaskId'].every(k=>typeof v?.[k]==='string'&&v[k]&&verify.payload?.[k]===v[k])
    ||verify.payload.verificationTaskId!==verify.taskId
    ||v.causalLease?.protocol!=='wecom-causal-v1'||v.causalLease?.purpose!=='verification'
    ||!equal(v.causalLease,verify.payload.causalLease))return null;
  try{
    const hosts=validateWecomHosts(d.hosts),reader=hosts.find(h=>h.role==='reader');
    return producerRef({pid:reader.pid,creationToken:reader.creationToken,machineId:reader.machineId});
  }catch{return null;}
}
export function originalRecoveryContext(state,lock){
  const d=lock?.physicalCleanup,b=d?.binding;
  const task=state.windowsTasks.find(t=>t.taskId===b?.originalTaskId),job=state.automationJobs.find(j=>j.jobId===d?.originalJobId);
  if(!b||b.version!==1||lock.deviceId!==b.deviceId||b.obligationId!==lock.lockId||b.deviceId!==`adb:${b.serial}`
    ||!((b.appSlot==='main'&&b.androidUser===0)||(b.appSlot==='clone'&&b.androidUser===999))
    ||!task||!job||task.type!=='wecom_customer_preview'||job.kind!==task.type||task.status!=='failed'||job.status!=='failed'
    ||!task.pickedAt||!d.originalTerminalAt
    ||task.agentId!==b.agentId||task.adbSerial!==b.serial||task.deviceId!==b.deviceId||job.deviceId!==b.deviceId
    ||job.windowsTaskId!==task.taskId||task.payload?.automationJobId!==job.jobId||job.lockId!==d.originalLockId
    ||job.agentId!==b.agentId||job.adbSerial!==b.serial||task.payload.appSlot!==b.appSlot||task.payload.androidUser!==b.androidUser
    ||job.wecomAppSlot!==b.appSlot||job.wecomAndroidUser!==b.androidUser||task.payload.phoneNumber!==job.phoneNumber
    ||!equal(task.payload.physicalCleanup,b)||task.payload.mode!=='preview'||task.payload.previewOnly!==true||job.wecomMode!=='preview'
    ||job.wecomSendClaimAt||job.wecomSendClaim||[task,job].some(x=>x.result?.sendClaimed===true)||task.result?.invitationSent!==false||job.result?.invitationSent!==false
    ||task.result?.sendStatus!=='not_attempted'||job.result?.sendStatus!=='not_attempted')recoveryFail('ineligible');
  const legacy=d.hosts===null&&d.hostClosedAt===''&&d.verification===null&&!d.causal
    &&[task,job].every(x=>x.result?.previewStatus==='blocked'&&x.result?.previewCode==='wecom_cleanup_host_unconfirmed'
      &&x.result?.message==='wecom_cleanup_host_unconfirmed'&&x.result?.errorCode==='task_failed');
  const retiredProducer=legacy?null:registeredConfigFailure(state,d,task,job);
  if(!legacy&&!retiredProducer)recoveryFail('ineligible');
  const original=state.deviceLocks.find(l=>l.lockId===d.originalLockId);
  if(!original||original.deviceId!==b.deviceId||original.taskId!==job.jobId||original.lockType!==task.type
    ||original.ownerUserId!==job.userId
    ||!['active','released'].includes(original.status))recoveryFail('original_lock_mismatch');
  // Canonical ordered projection: no current time, volatile device status or
  // recovery fields, and no customer numbers in the resulting public proposal.
  const fingerprint=createHash('sha256').update(JSON.stringify(canonical({binding:b,task,job,original:{lockId:original.lockId,deviceId:original.deviceId,taskId:original.taskId,lockType:original.lockType,ownerUserId:original.ownerUserId},
    originalJobId:d.originalJobId,originalLockId:d.originalLockId,originalTerminalAt:d.originalTerminalAt,hosts:d.hosts,hostClosedAt:d.hostClosedAt,verification:d.verification,...(retiredProducer?{causal:d.causal,verificationTask:state.windowsTasks.find(t=>t.taskId===d.verification.verificationTaskId)}:{})}))).digest('hex');
  return {task,job,original,fingerprint,retiredProducer};
}
export function canRetryRecovery(state,lock){
  const d=lock?.physicalCleanup,v=d?.recovery,history=d?.recoveryHistory||[];
  const task=state.windowsTasks.find(t=>t.taskId===v?.verificationTaskId);
  return Boolean(isWecomCleanupPending(lock)&&Array.isArray(history)&&history.length<4&&v&&!v.proof
    &&task?.status==='failed'&&task.type==='wecom_cleanup_verify'&&task.payload?.preinputRecovery===PREINPUT_RECOVERY
    &&task.payload.verificationTaskId===v.verificationTaskId&&equal(task.payload.physicalCleanup,d.binding)
    &&task.deviceId===lock.deviceId&&task.agentId===d.binding.agentId&&task.result?.cleanupVerified!==true
    &&['wecom_cleanup_recovery_worker_present','wecom_cleanup_verify_timeout','wecom_cleanup_recovery_processes_unconfirmed','wecom_cleanup_worker_timeout','wecom_cleanup_request_failed'].includes(task.result?.errorCode));
}
export function recoveryProposal(state,lock){
  const {fingerprint,retiredProducer}=originalRecoveryContext(state,lock),b=lock.physicalCleanup.binding;
  return {protocol:PREINPUT_RECOVERY,obligationId:lock.lockId,deviceId:lock.deviceId,originalTaskId:b.originalTaskId,
    originalJobId:lock.physicalCleanup.originalJobId,fingerprint,pending:isWecomCleanupPending(lock),
    requiresRetiredProducer:true,requiresAgentReload:!retiredProducer,...(retiredProducer?{retiredProducer}:{}),canRetry:canRetryRecovery(state,lock),attempt:lock.physicalCleanup.recovery?.verificationTaskId||null};
}
export function recoveryRequest(body){
  if(!(exact(body,['protocol','requestId','fingerprint','retiredProducer','acknowledgeMaintenance'])||exact(body,['protocol','requestId','fingerprint','retiredProducer','acknowledgeMaintenance','retryOf']))||body.protocol!==PREINPUT_RECOVERY
    ||!id(body.requestId)||typeof body.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(body.fingerprint)
    ||body.acknowledgeMaintenance!==true||(body.retryOf!==undefined&&!id(body.retryOf)))recoveryFail('request_invalid');
  producerRef(body.retiredProducer);return structuredClone(body);
}
export function validateRecoveryProof(body,{binding,recovery}){
  if(!exact(body,['binding','verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer','observer','snapshots'])
    ||!equal(body.binding,binding)||!['verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer'].every(k=>equal(body[k],recovery[k])))recoveryFail('proof_invalid');
  const observer=producerRef(body.observer),old=recovery.retiredProducer;
  if(observer.machineId!==old.machineId||equal(observer,old))recoveryFail('producer_not_retired');
  if(!Array.isArray(body.snapshots)||body.snapshots.length!==2)recoveryFail('proof_invalid');
  let previous=-1;
  for(const [i,f]of body.snapshots.entries()){
    if(!exact(f,['sequence','elapsedMs','observedAt','packagesAbsent','packageNames','serialForwardCount','producerRetired','wecomWorkersAbsent'])
      ||f.sequence!==i+1||!Number.isFinite(f.elapsedMs)||f.elapsedMs<0||f.elapsedMs<=previous||f.elapsedMs>3000
      ||typeof f.observedAt!=='string'||!Number.isFinite(Date.parse(f.observedAt))||f.packagesAbsent!==true||!equal(f.packageNames,WECOM_PACKAGES)
      ||f.serialForwardCount!==0||f.producerRetired!==true||f.wecomWorkersAbsent!==true)recoveryFail('proof_invalid');
    previous=f.elapsedMs;
  }
  return structuredClone(body);
}
