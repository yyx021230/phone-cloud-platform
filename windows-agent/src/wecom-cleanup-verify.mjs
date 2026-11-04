import {spawn} from 'node:child_process';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {physicalBinding,physicalHosts,createCleanupRequest,cleanupRoute,submitSamePhysicalProof,WECOM_CAUSAL_PROTOCOL} from './wecom-cleanup-protocol.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const code=e=>/^wecom_[a-z0-9_]{1,90}$/.test(e?.message||'')?e.message:'wecom_cleanup_verify_unconfirmed';
const problem=value=>new Error(value);
function verificationConfig(task,config){
  if(task.type!=='wecom_cleanup_verify')throw problem('wecom_cleanup_task_invalid');
  const binding=physicalBinding(task,config,{verification:true}),p=task.payload;
  if(!exact(p,['physicalCleanup','verificationId','verificationNonce','verificationTaskId','issuedAt','expiresAt','pickedAt','hosts','causalLease'])
    ||p.verificationTaskId!==task.taskId||!['verificationId','verificationNonce','verificationTaskId'].every(k=>typeof p[k]==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(p[k]))
    ||!['issuedAt','expiresAt'].every(k=>typeof p[k]==='string'&&Number.isFinite(Date.parse(p[k])))
    ||!Number.isFinite(Date.parse(task.pickedAt))||!exact(p.causalLease,['protocol','epoch','leaseId','purpose'])||p.causalLease.protocol!==WECOM_CAUSAL_PROTOCOL||p.causalLease.purpose!=='verification')throw problem('wecom_cleanup_task_invalid');
  return{taskId:task.taskId,deviceId:binding.deviceId,serial:binding.serial,agentId:binding.agentId,serverBaseUrl:config.serverBaseUrl,agentToken:config.agentToken,
    physicalCleanup:binding,verificationId:p.verificationId,verificationNonce:p.verificationNonce,verificationTaskId:p.verificationTaskId,
    issuedAt:p.issuedAt,expiresAt:p.expiresAt,pickedAt:task.pickedAt,hosts:physicalHosts(p.hosts),causalLease:{...p.causalLease}};
}
function validateProof(proof,input){
  if(!exact(proof,['binding','verificationId','verificationNonce','verificationTaskId','challenge','snapshots'])||!isDeepStrictEqual(proof.binding,input.physicalCleanup)||!isDeepStrictEqual(proof.challenge,input.challenge)
    ||!['verificationId','verificationNonce','verificationTaskId'].every(k=>proof[k]===input[k])||!Array.isArray(proof.snapshots)||proof.snapshots.length!==2)throw problem('wecom_cleanup_proof_invalid');
  let previous=-1;
  for(const [i,frame] of proof.snapshots.entries()){
    if(!exact(frame,['sequence','elapsedMs','observedAt','packagesAbsent','packageNames','serialForwardCount'])||frame.packagesAbsent!==true||frame.serialForwardCount!==0
      ||!isDeepStrictEqual(frame.packageNames,['com.netease.open.pocoservice','com.netease.open.pocoservice.test'])
      ||typeof frame.observedAt!=='string'||!Number.isFinite(Date.parse(frame.observedAt))||frame.sequence!==i+1||!Number.isFinite(frame.elapsedMs)||frame.elapsedMs<=previous||frame.elapsedMs<0||frame.elapsedMs>3000)throw problem('wecom_cleanup_proof_invalid');
    previous=frame.elapsedMs;
  }
  return proof;
}

export async function nativeProof(input,{config,agentDir,signal,spawnChild=spawn,script='wecom_cleanup_verify.py',validate=validateProof}={}){
  if(signal?.aborted)throw problem('wecom_cleanup_cancelled');
  return new Promise((resolve,reject)=>{
    let child,output='',settled=false,reason=null,killTimer=null,started=false;
    try{child=spawnChild(config.pythonCommand,[path.join(agentDir,'scripts',script)],{cwd:agentDir,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});}
    catch{reject(problem('wecom_cleanup_worker_start_failed'));return;}
    started=Number.isInteger(child.pid)&&child.pid>0;child.once('spawn',()=>started=true);
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(result);
    };
    const stop=error=>{
      if(settled||reason)return;reason=error;
      try{child.stdin.end('cancel\n');}catch{}
      killTimer=setTimeout(()=>{try{child.kill();}catch{}},15000); // An attempt is never close proof.
    };
    const abort=()=>stop(problem('wecom_cleanup_cancelled'));
    const timer=setTimeout(()=>stop(problem('wecom_cleanup_worker_timeout')),20000);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{if(output.length<=16384)output+=b.toString('utf8').slice(0,16385-output.length);if(output.length>16384)stop(problem('wecom_cleanup_worker_output_invalid'));});
    child.stdin.on('error',()=>stop(problem('wecom_cleanup_input_unknown')));
    child.on('error',()=>started?stop(problem('wecom_cleanup_worker_unknown')):finish(problem('wecom_cleanup_worker_start_failed')));
    child.on('close',exit=>{
      if(settled)return;
      if(reason){finish(reason);return;}
      try{
        if(exit!==0)throw problem('wecom_cleanup_worker_unknown');
        const value=JSON.parse(output.trim());
        if(value.ok===false&&exact(value,['ok','code']))throw problem(code({message:value.code}));
        if(!exact(value,['ok','proof'])||value.ok!==true)throw problem('wecom_cleanup_worker_output_invalid');
        finish(null,validate(value.proof,input));
      }catch(error){finish(problem(code(error)));}
    });
    try{child.stdin.write(JSON.stringify(input)+'\n');}catch{stop(problem('wecom_cleanup_input_unknown'));}
    if(signal?.aborted)abort();
  });
}

export async function runWecomCleanupVerifyTask(task,{config,agentDir,signal,spawnChild=spawn,cleanupRequest=createCleanupRequest(config)}={}){
  const input=verificationConfig(task,config);
  if(signal?.aborted)throw problem('wecom_cleanup_cancelled');
  const q=new URLSearchParams(Object.fromEntries(['verificationId','verificationNonce','verificationTaskId'].map(k=>[k,input[k]])));
  const leaseStarted=performance.now();
  const before=await cleanupRequest(cleanupRoute(input.physicalCleanup,'lease')+'?'+q,{method:'GET'});
  if(before?.valid!==true||!isDeepStrictEqual(before.causalLease,input.causalLease)||!Number.isSafeInteger(before.remainingMs)||before.remainingMs>120000||before.remainingMs-(performance.now()-leaseStarted)<=3000)throw problem('wecom_cleanup_lease_lost');
  const challengeStarted=performance.now();
  const response=await cleanupRequest(cleanupRoute(input.physicalCleanup,'challenge'),{body:{binding:input.physicalCleanup,...Object.fromEntries(['verificationId','verificationNonce','verificationTaskId'].map(k=>[k,input[k]]))},timeoutMs:3000});
  const c=response?.challenge;
  if(response?.ok!==true||!exact(c,['protocol','epoch','verificationLeaseId','challengeId'])||c.protocol!==WECOM_CAUSAL_PROTOCOL||c.epoch!==input.causalLease.epoch||c.verificationLeaseId!==input.causalLease.leaseId||typeof c.challengeId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(c.challengeId)||performance.now()-challengeStarted>=3000)throw problem('wecom_cleanup_proof_invalid');
  input.challenge={...c};
  const proof=await nativeProof(input,{config,agentDir,signal,spawnChild});
  // nativeProof resolves only after the owned child actually closes.
  if(performance.now()-challengeStarted>3000)throw problem('wecom_cleanup_proof_invalid');
  if(signal?.aborted)throw problem('wecom_cleanup_cancelled');
  // The exact first-fact timestamps survive stdout, OS close and a lost ACK.
  // No normal taskStatus(succeeded): this endpoint atomically commits success.
  await submitSamePhysicalProof(input.physicalCleanup,proof,{request:cleanupRequest});
  return{verified:true,code:'wecom_cleanup_verified'};
}

export async function handleWecomCleanupVerification(task,{reportFailure=async()=>{},event=async()=>{},run=runWecomCleanupVerifyTask,...options}={}){
  const emit=async(...args)=>{try{await event(...args);}catch{}};
  await emit('start','info','开始核验企微单机工具状态');
  try{
    const result=await run(task,options);
    await emit('finish','info','企微单机工具状态已核验');
    return result;
  }catch(error){
    const failure=code(error);
    await emit('finish','warn',failure);
    if(error.proofDeliveryUnknown!==true)try{await reportFailure({errorCode:failure,code:failure,cleanupVerified:false});}catch{}
    return{verified:false,pending:true,code:failure};
  }
}
