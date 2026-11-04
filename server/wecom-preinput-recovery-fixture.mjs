// Synthetic replica of the 155 pre-input failure; no real nonce or customer.
import {createWecomCleanupService} from './wecom-cleanup-service.mjs';
import {createWecomCausalClock} from './wecom-causal-clock.mjs';
import {PREINPUT_RECOVERY} from './wecom-preinput-recovery.mjs';
export function recoveryFixture({persist}={}){
 let mono=0n,n=0,wall=Date.parse('2026-11-03T09:00:00.000Z'),blocked=false,reject=false;
 const at=()=>new Date(wall).toISOString(),binding={version:1,obligationId:'obligation',originalTaskId:'original-task',executionId:'execution',deviceId:'adb:synthetic155',serial:'synthetic155',agentId:'fixture-agent',appSlot:'main',androidUser:0,nonce:'synthetic-nonce'};
 const result={previewStatus:'blocked',errorCode:'task_failed',previewCode:'wecom_cleanup_host_unconfirmed',message:'wecom_cleanup_host_unconfirmed',invitationSent:false,sendStatus:'not_attempted',remarkSaveStatus:'unknown'};
 const task={taskId:binding.originalTaskId,type:'wecom_customer_preview',status:'failed',agentId:binding.agentId,deviceId:binding.deviceId,adbSerial:binding.serial,pickedAt:at(),payload:{automationJobId:'job',physicalCleanup:binding,mode:'preview',previewOnly:true,appSlot:'main',androidUser:0,phoneNumber:'13900000000'},result:structuredClone(result)};
 const job={jobId:'job',userId:'fixture-owner',wecomAppSlot:'main',wecomAndroidUser:0,phoneNumber:'13900000000',kind:task.type,status:'failed',deviceId:binding.deviceId,agentId:binding.agentId,adbSerial:binding.serial,windowsTaskId:task.taskId,lockId:'original-lock',wecomMode:'preview',result:structuredClone(result)};
 const original={ownerUserId:'fixture-owner',lockId:'original-lock',lockType:task.type,taskId:job.jobId,status:'released',deviceId:binding.deviceId};
 const lock={lockId:binding.obligationId,lockType:'wecom_physical_cleanup',status:'cleanup_pending',deviceId:binding.deviceId,
  physicalCleanup:{binding,originalJobId:job.jobId,originalLockId:original.lockId,originalTerminalAt:at(),phase:'awaiting_host',hosts:null,hostClosedAt:'',verification:null}};
 const state={windowsAgents:[{agentId:binding.agentId,wecomRecoveryProtocol:PREINPUT_RECOVERY,wecomRecoveryAt:at()}],devices:[{deviceId:binding.deviceId,adb:{serial:binding.serial,agentId:binding.agentId}}],windowsTasks:[task],automationJobs:[job],deviceLocks:[lock,original]};
 const clock=createWecomCausalClock({mono:()=>mono,epoch:'fixture-epoch'}),writes=[];
 const options={state,clock,now:()=>wall,id:()=>`fixture-${++n}`,conflict:()=>blocked,persist:async b=>{if(reject)throw Error('synthetic save failure');if(persist)await persist(b);writes.push(structuredClone(b));}};
 const service=createWecomCleanupService(options);
 const producer={pid:100,creationToken:'0x1.9000000000000p+30',machineId:'a'.repeat(64)};
 const request=()=>({protocol:PREINPUT_RECOVERY,requestId:'recovery-request',fingerprint:service.recoveryGet(lock.lockId).fingerprint,retiredProducer:producer,acknowledgeMaintenance:true});
 const start=async()=>service.recoveryStart(lock.lockId,request(),'operator');
 const getTask=()=>state.windowsTasks.find(t=>t.payload?.preinputRecovery);
 function pick(){const t=getTask();t.status='running';t.pickedAt=at();service.picked(t);return t;}
 const fields=()=>{const v=lock.physicalCleanup.recovery;return Object.fromEntries(['verificationId','verificationNonce','verificationTaskId'].map(k=>[k,v[k]]));};
 const call=(action,body)=>service.recoveryHandle(binding.agentId,lock.lockId,action,body);
 const challenge=()=>call('recovery-challenge',{binding,...fields()});
 const proof=()=>({binding,...fields(),challenge:lock.physicalCleanup.recovery.challenge,retiredProducer:producer,observer:{...producer,pid:200},snapshots:[1,2].map(i=>({sequence:i,elapsedMs:100*i,observedAt:at(),packagesAbsent:true,packageNames:['com.netease.open.pocoservice','com.netease.open.pocoservice.test'],serialForwardCount:0,producerRetired:true,wecomWorkersAbsent:true}))});
 return {state,lock,original,task,job,binding,options,service,start,request,getTask,pick,fields,call,challenge,proof,writes,
  step:ms=>{mono+=BigInt(ms)*1000000n;wall+=ms;},block:b=>blocked=b,rejectSave:b=>reject=b};
}
