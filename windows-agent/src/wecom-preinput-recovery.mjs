import {isDeepStrictEqual as equal} from 'node:util';
import {physicalBinding,createCleanupRequest,cleanupRoute,submitSamePhysicalProof,WECOM_CAUSAL_PROTOCOL} from './wecom-cleanup-protocol.mjs';
import {nativeProof} from './wecom-cleanup-verify.mjs';
export const PREINPUT_RECOVERY='wecom-preinput-recovery-v1';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw Error('wecom_cleanup_recovery_invalid');};
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
function producer(v){
  if(!exact(v,['pid','creationToken','machineId'])||!Number.isSafeInteger(v.pid)||v.pid<=0||v.pid>0xffffffff
    ||typeof v.creationToken!=='string'||!/^0x1\.[0-9a-f]{13}p\+\d{1,4}$/.test(v.creationToken)
    ||typeof v.machineId!=='string'||!/^[a-f0-9]{64}$/.test(v.machineId))fail();return {...v};
}
export function recoveryConfig(task,config){
  const p=task.payload,b=physicalBinding(task,config,{verification:true});
  if(task.type!=='wecom_cleanup_verify'||!exact(p,['physicalCleanup','preinputRecovery','verificationId','verificationNonce','verificationTaskId','issuedAt','retiredProducer','causalLease'])
    ||p.preinputRecovery!==PREINPUT_RECOVERY||p.verificationTaskId!==task.taskId||!['verificationId','verificationNonce','verificationTaskId'].every(k=>identifier(p[k]))
    ||!Number.isFinite(Date.parse(p.issuedAt))||!Number.isFinite(Date.parse(task.pickedAt))
    ||!exact(p.causalLease,['protocol','epoch','leaseId','purpose'])||p.causalLease.protocol!==WECOM_CAUSAL_PROTOCOL||p.causalLease.purpose!=='verification'
    ||!identifier(p.causalLease.epoch)||!identifier(p.causalLease.leaseId))fail();
  return {...structuredClone(p),physicalCleanup:b,taskId:task.taskId,deviceId:b.deviceId,serial:b.serial,agentId:b.agentId,
    serverBaseUrl:config.serverBaseUrl,agentToken:config.agentToken,retiredProducer:producer(p.retiredProducer)};
}
export function recoveryProof(proof,input){
  if(!exact(proof,['binding','verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer','observer','snapshots'])
    ||!equal(proof.binding,input.physicalCleanup)||!['verificationId','verificationNonce','verificationTaskId','challenge','retiredProducer'].every(k=>equal(proof[k],input[k])))fail();
  const observer=producer(proof.observer);
  if(equal(observer,input.retiredProducer)||observer.machineId!==input.retiredProducer.machineId||!Array.isArray(proof.snapshots)||proof.snapshots.length!==2)fail();
  let previous=-1;
  for(const [i,f]of proof.snapshots.entries()){
    if(!exact(f,['sequence','elapsedMs','observedAt','packagesAbsent','packageNames','serialForwardCount','producerRetired','wecomWorkersAbsent'])
      ||f.sequence!==i+1||!Number.isFinite(f.elapsedMs)||f.elapsedMs<0||f.elapsedMs<=previous||f.elapsedMs>3000||typeof f.observedAt!=='string'||!Number.isFinite(Date.parse(f.observedAt))
      ||f.packagesAbsent!==true||!equal(f.packageNames,['com.netease.open.pocoservice','com.netease.open.pocoservice.test'])
      ||f.serialForwardCount!==0||f.producerRetired!==true||f.wecomWorkersAbsent!==true)fail();previous=f.elapsedMs;
  }
  return proof;
}
export async function runWecomPreinputRecovery(task,{config,agentDir,signal,spawnChild,cleanupRequest=createCleanupRequest(config),prove=nativeProof}={}){
  const input=recoveryConfig(task,config),binding=input.physicalCleanup;
  if(signal?.aborted)throw Error('wecom_cleanup_cancelled');
  const fields=Object.fromEntries(['verificationId','verificationNonce','verificationTaskId'].map(k=>[k,input[k]]));
  const began=performance.now(),lease=await cleanupRequest(cleanupRoute(binding,'recovery-lease')+'?'+new URLSearchParams(fields),{method:'GET'});
  if(lease?.valid!==true||!equal(lease.causalLease,input.causalLease)||!Number.isSafeInteger(lease.remainingMs)||lease.remainingMs>120000||lease.remainingMs-(performance.now()-began)<=3000)fail();
  const challenged=performance.now(),response=await cleanupRequest(cleanupRoute(binding,'recovery-challenge'),{body:{binding,...fields},timeoutMs:3000}),c=response?.challenge;
  if(response?.ok!==true||!exact(c,['protocol','epoch','verificationLeaseId','challengeId'])||c.protocol!==WECOM_CAUSAL_PROTOCOL
    ||c.epoch!==input.causalLease.epoch||c.verificationLeaseId!==input.causalLease.leaseId||!identifier(c.challengeId)||performance.now()-challenged>=3000)fail();
  input.challenge={...c};
  const proof=await prove(input,{config,agentDir,signal,spawnChild,script:'wecom_preinput_recovery.py',validate:recoveryProof});
  recoveryProof(proof,input);
  if(signal?.aborted||performance.now()-challenged>3000)fail();
  await submitSamePhysicalProof(binding,proof,{request:cleanupRequest,action:'recovery-proof'});
  return {verified:true,code:'wecom_cleanup_recovery_verified'};
}
