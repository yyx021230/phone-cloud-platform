// Pure proposal classification only. No SQL, writes, release, executor or
// canonical provenance attestation. Even legacy_candidate permits no write.
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { createWecomV2ClaimPreparer } from "./wecom-cleanup-v2-claim.mjs";
import { validateWecomV2HostState } from "./wecom-cleanup-v2-host.mjs";
const id=v=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,160}$/.test(v);
const exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=()=>{throw Error("projection_policy_invalid");};
const sha=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const columns=[
  ["anchor","physical_key,device_id,active_obligation_id,active_claim_operation_id,agent_id,mapping_revision,mapping_fingerprint,mapping_state"],
  ["windowsTask","task_id,agent_id,adb_serial,status,created_at,updated_at,data"],
  ["automationJob","job_id,device_id,user_id,kind,status,created_at,updated_at,data"],
  ["physicalHold","lock_id,device_id,status,expires_at,data"],
  ["businessLock","lock_id,device_id,status,expires_at,data"],
  ["ledger","obligation_id,server_epoch,revision,host_operation_id,close_operation_id,protocol_state,claim_data"]
];
function json(value){
  let nodes=0;const active=new WeakSet();
  function visit(v,depth){
    if(++nodes>50000||depth>24)fail();
    if(v===null||typeof v==="boolean")return;
    if(typeof v==="string"&&!/[\u0000\ud800-\udfff]/u.test(v))return;
    if(typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER&&!Object.is(v,-0))return;
    if(!v||typeof v!=="object"||active.has(v)||(!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v))))fail();
    active.add(v);const keys=Reflect.ownKeys(v);
    if(Array.isArray(v)&&(keys.length!==v.length+1||!Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean)))fail();
    for(const k of keys){if(Array.isArray(v)&&k==="length")continue;const d=Object.getOwnPropertyDescriptor(v,k);if(typeof k!=="string"||!d.enumerable||!Object.hasOwn(d,"value"))fail();visit(d.value,depth+1);}active.delete(v);
  }visit(value,0);const s=JSON.stringify(value);if(Buffer.byteLength(s)>262144)fail();return JSON.parse(s);
}
function freeze(v){if(v&&typeof v==="object"){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function reply(targetIndex,decision,reason){return freeze({targetIndex,decision,reason,writePermit:false,protocolPermit:false,releaseAllowed:false,
  retainExistingObligations:true,canonicalSourceVerified:false,liveChecksRequired:true});}
function target(v){
  if(!exact(v,["deviceId","serial","agentId"])||typeof v.serial!=="string"||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v.serial)
    ||v.deviceId!==`adb:${v.serial}`||!id(v.agentId))fail();return v;
}
const canonicalTime=v=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function rowProjection(kind,row){
  if(!exact(row,columns.find(([k])=>k===kind)[1].split(",")))fail();
  if(["anchor","ledger"].includes(kind))return;
  const d=row.data;if(!d||typeof d!=="object"||Array.isArray(d))fail();
  const pairs=kind==="windowsTask"?{task_id:"taskId",agent_id:"agentId",adb_serial:"adbSerial",status:"status"}
    :kind==="automationJob"?{job_id:"jobId",device_id:"deviceId",user_id:"userId",kind:"kind",status:"status"}
      :{lock_id:"lockId",device_id:"deviceId",status:"status"};
  for(const [a,b]of Object.entries(pairs))if(typeof row[a]!=="string"||row[a]!==d[b])fail();
  if(["windowsTask","automationJob"].includes(kind)){
    for(const [a,b]of [["created_at","createdAt"],["updated_at","updatedAt"]])if(!canonicalTime(row[a])||row[a]!==d[b])fail();
  }else if(row.expires_at!==(d.expiresAt===""?null:d.expiresAt)||(row.expires_at!==null&&!canonicalTime(row.expires_at)))fail();
}
function claimed(c,t,epoch){
  if(!exact(c,[...columns.map(([k])=>k),"device"]))fail();
  for(const [kind]of columns)rowProjection(kind,c[kind]);
  const a=c.anchor,l=c.ledger,b=validateWecomV2HostState(l.protocol_state).binding,claim=l.claim_data;
  if(!exact(claim,["version","claimOperationId","originalJobId","originalLockId","ownerUserId","requestId","mode","businessFingerprint","recordedAt","binding"])
    ||claim.version!==1||!equal(claim.binding,b)||b.serverEpoch!==epoch||b.deviceId!==t.deviceId||b.serial!==t.serial||b.agentId!==t.agentId
    ||l.obligation_id!==b.obligationId||l.server_epoch!==b.serverEpoch||l.revision!==l.protocol_state.revision
    ||l.host_operation_id!==l.protocol_state.hostOperationId||l.close_operation_id!==l.protocol_state.closeOperationId
    ||[l.host_operation_id,l.close_operation_id].includes(claim.claimOperationId))fail();
  if(a.physical_key!==t.serial.toLowerCase()||a.device_id!==t.deviceId||a.agent_id!==t.agentId||a.mapping_state!=="ready"
    ||typeof a.mapping_revision!=="string"||!(/^[1-9][0-9]*$/).test(a.mapping_revision)||a.active_obligation_id!==b.obligationId||a.active_claim_operation_id!==claim.claimOperationId
    ||a.mapping_fingerprint!==sha([t.deviceId,t.serial,t.agentId,c.device?.deviceName]))fail();
  const task=c.windowsTask.data,job=c.automationJob.data,hold=c.physicalHold.data,lock=c.businessLock.data;
  if(!equal(task.wecomV2Claim,claim)||!equal(job.wecomV2Claim,claim)||!equal(task.payload?.physicalCleanup,b)
    ||task.pickedAt!==claim.recordedAt||job.pickedAt!==claim.recordedAt
    ||![task.status,job.status].every(s=>["running","stalled","succeeded","failed","cancelled","expired"].includes(s)))fail();
  if(hold.lockId!==b.obligationId||hold.taskId!==b.obligationId||hold.deviceId!==b.deviceId||hold.appSlot!==b.appSlot||hold.ownerUserId!==claim.ownerUserId
    ||hold.lockType!=="wecom_physical_cleanup"||hold.status!=="cleanup_pending"||hold.expiresAt!==""||c.physicalHold.expires_at!==null
    ||!equal(hold.physicalCleanup?.binding,b)||hold.physicalCleanup.originalJobId!==claim.originalJobId||hold.physicalCleanup.originalLockId!==claim.originalLockId
    ||!["awaiting_host","awaiting_host_close","awaiting_verification","maintenance"].includes(hold.physicalCleanup.phase)
    ||!["active","released","expired"].includes(lock.status))fail();
  const context=Object.fromEntries(["claimOperationId","originalJobId","originalLockId","ownerUserId","requestId","mode","businessFingerprint","recordedAt","binding"].map(k=>[k,claim[k]]));
  context.target={deviceNumber:c.device.deviceName,appSlot:b.appSlot,androidUser:b.androidUser};
  const ptask=structuredClone(task),pjob=structuredClone(job),plock=structuredClone(lock);
  delete ptask.wecomV2Claim;delete ptask.payload.physicalCleanup;delete pjob.wecomV2Claim;
  for(const v of[ptask,pjob]){v.status="queued";v.pickedAt=null;v.completedAt=null;v.result={};}pjob.wecomSendClaimAt="";plock.status="active";
  createWecomV2ClaimPreparer({readClaimContext:()=>context})({task:ptask,job:pjob,businessLock:plock,device:c.device});
  return {claim,b,task,job,hold,lock,device:c.device};
}
function proposals(writes,canon){
  if(!Array.isArray(writes)||writes.length>64)fail();
  const byKind={windowsTask:canon.task,automationJob:canon.job,physicalHold:canon.hold,businessLock:canon.lock,device:canon.device};
  const fields={windowsTask:["taskId","agentId","deviceId","adbSerial","type"],automationJob:["jobId","userId","deviceId","sessionId","xhsAppSlot","windowsTaskId","agentId","adbSerial","lockId","phoneNumber","wecomMode","wecomRequestId","wecomDeviceNumber","wecomAppSlot","wecomAndroidUser","wecomRemarkName","wecomDescription"],
    physicalHold:["lockId","taskId","lockType","deviceId","appSlot","ownerUserId"],businessLock:["lockId","taskId","lockType","deviceId","appSlot","ownerUserId"],device:["deviceId","deviceName"]};
  for(const w of writes){
    if(!exact(w,["kind","record"])||!Object.hasOwn(byKind,w.kind)||!w.record||typeof w.record!=="object"||Array.isArray(w.record))fail();
    const current=byKind[w.kind],incoming=w.record;
    for(const field of fields[w.kind])if(!equal(incoming[field],current[field]))fail();
    if(w.kind==="windowsTask"){
      for(const k of["automationJobId","automationSessionId","deviceNumber","appSlot","androidUser","mode","previewOnly","phoneNumber","remarkName","description","xhsAppSlot"])if(!equal(incoming.payload?.[k],current.payload[k]))fail();
      if(Object.hasOwn(incoming,"wecomV2Claim")&&!equal(incoming.wecomV2Claim,canon.claim))fail();
      if(Object.hasOwn(incoming.payload||{},"physicalCleanup")&&!equal(incoming.payload.physicalCleanup,canon.b))fail();
    }
    if(w.kind==="automationJob"&&Object.hasOwn(incoming,"wecomV2Claim")&&!equal(incoming.wecomV2Claim,canon.claim))fail();
    if(w.kind==="physicalHold"&&(!equal(incoming.physicalCleanup?.binding,canon.b)||incoming.physicalCleanup?.originalJobId!==canon.claim.originalJobId||incoming.physicalCleanup?.originalLockId!==canon.claim.originalLockId))fail();
    if(w.kind==="device"&&(incoming.adb?.serial!==canon.b.serial||incoming.adb?.agentId!==canon.b.agentId))fail();
  }
}
export function createWecomV2ProjectionPolicy(options={}){
  if(!exact(options,["readPolicyEpoch","readCanonicalProjection"])||!["readPolicyEpoch","readCanonicalProjection"].every(k=>typeof Object.getOwnPropertyDescriptor(options,k)?.value==="function"))throw Error("projection_policy_providers_required");
  const {readPolicyEpoch,readCanonicalProjection}=options,epoch=readPolicyEpoch();if(!id(epoch))throw Error("projection_policy_epoch_invalid");
  return input=>{
    let targets,length;try{const d=input&&Object.getOwnPropertyDescriptor(input,"targets");if(!exact(input,["targets"])||!Array.isArray(d?.value)||d.value.length>128)fail();targets=d.value;length=targets.length;}catch{return freeze({requestError:"invalid_batch",results:[],writePermit:false,protocolPermit:false});}
    const results=[];
    for(let i=0;i<length;i++){
      let request;try{request=json(Object.getOwnPropertyDescriptor(targets,String(i))?.value);if(!exact(request,["target","writes"])||!Array.isArray(request.writes)||request.writes.length>64)fail();target(request.target);
        for(const w of request.writes)if(!exact(w,["kind","record"])||!["windowsTask","automationJob","physicalHold","businessLock","device"].includes(w.kind)||!w.record||typeof w.record!=="object"||Array.isArray(w.record)||w.record.deviceId!==request.target.deviceId)fail();
      }catch{results.push(reply(i,"reject_target","invalid_target_input"));continue;}
      let o;try{if(readPolicyEpoch()!==epoch)fail();o=json(readCanonicalProjection(freeze(structuredClone(request.target))));if(readPolicyEpoch()!==epoch)fail();}
      catch{results.push(reply(i,"ownership_unconfirmed","observation_unavailable"));continue;}
      if(!exact(o,["version","kind","observationId","serverEpoch","target","canonical","legacyPending"])||o.version!==1||!id(o.observationId)||o.serverEpoch!==epoch||!equal(o.target,request.target)||!Array.isArray(o.legacyPending)){
        results.push(reply(i,"ownership_unconfirmed","observation_incomplete"));continue;
      }
      if(!["present","observed_absent"].includes(o.kind)){results.push(reply(i,"ownership_unconfirmed","ownership_not_observed"));continue;}
      if(o.legacyPending.length){results.push(reply(i,"reject_target","legacy_obligation_pending"));continue;}
      if(o.kind==="observed_absent"){
        results.push(reply(i,o.canonical===null?"legacy_candidate":"reject_target",o.canonical===null?"v2_absence_observed_not_authorized":"absence_conflicts_with_records"));continue;
      }
      try{const c=claimed(o.canonical,request.target,epoch);proposals(request.writes,c);results.push(reply(i,"retain_canonical","protected_projection"));}
      catch{results.push(reply(i,"reject_target","canonical_or_proposal_conflict"));}
    }
    return freeze({requestError:null,results,writePermit:false,protocolPermit:false});
  };
}
