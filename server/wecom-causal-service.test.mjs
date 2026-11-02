import assert from "node:assert/strict";
import test from "node:test";
import {createWecomCleanupService} from "./wecom-cleanup-service.mjs";
import {createWecomCausalClock} from "./wecom-causal-clock.mjs";
import {createWecomCleanupObligation,WECOM_PACKAGES} from "./wecom-physical-cleanup.mjs";
import {syntheticHostTime} from "./wecom-cleanup-fixture.mjs";
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(offset=0,providedClock=null){
  let mono=0n,wall=Date.parse("2026-11-03T00:00:00.000Z"),n=0,clockId=0,writer=async()=>{};
  const device={deviceId:"adb:synthetic",adb:{serial:"synthetic",agentId:"fixture-agent"}};
  const job={jobId:"job-one",kind:"wecom_customer_preview",lockId:"lock-one",windowsTaskId:"task-one",userId:"owner",deviceId:device.deviceId,adbSerial:"synthetic",agentId:"fixture-agent",status:"queued",wecomMode:"preview",wecomAppSlot:"main",wecomAndroidUser:0,phoneNumber:"13900000000",wecomRemarkName:"测试客户",wecomDescription:"接口联调测试"};
  const task={taskId:"task-one",type:job.kind,status:"queued",deviceId:device.deviceId,adbSerial:"synthetic",agentId:"fixture-agent",payload:{automationJobId:job.jobId,phoneNumber:job.phoneNumber,remarkName:job.wecomRemarkName,description:job.wecomDescription,appSlot:"main",androidUser:0,mode:"preview"}};
  const businessLock={lockId:job.lockId,deviceId:device.deviceId,taskId:job.jobId,lockType:job.kind,status:"active",ownerUserId:job.userId,expiresAt:new Date(wall+300000).toISOString()};
  const state={devices:[device],automationJobs:[job],windowsTasks:[task],deviceLocks:[businessLock]},saved=[];
  const clock=providedClock||createWecomCausalClock({mono:()=>mono,id:()=>`clock-${++clockId}`,epoch:"epoch-one"});
  const options={state,now:()=>wall,id:()=>`fixture-${++n}`,persist:async bundle=>{saved.push(structuredClone(bundle));await writer(bundle);}};
  const service=createWecomCleanupService({...options,clock});service.bindBusinessLease(service.beginBusinessLease(),task,job,businessLock);
  task.status="running";const lock=service.createObligation(task,job,device);state.deviceLocks.unshift(lock);task.payload.physicalCleanup=structuredClone(lock.physicalCleanup.binding);job.status="running";
  const binding=structuredClone(lock.physicalCleanup.binding),bootstrap={protocol:"wecom-causal-v1",bindingNonce:binding.nonce,pipeNonce:"b".repeat(48)};
  const hosts=[{role:"reader",pid:123,...syntheticHostTime(wall+offset),machineId:"a".repeat(64)}];
  const close={binding,hosts,bootstrap,observedAt:new Date(wall-offset).toISOString(),exited:true,observerMachineId:hosts[0].machineId};
  const call=(action,body)=>service.handle("fixture-agent",lock.lockId,action,body);
  async function ready(){await call("host",{binding,hosts,bootstrap});task.status=job.status="failed";service.noteTerminal(task,job);await call("host-closed",close);const v=await call("verify",{binding});const t=state.windowsTasks.find(t=>t.taskId===v.taskId);t.status="running";t.pickedAt=new Date(wall).toISOString();service.picked(t);const fields=Object.fromEntries(["verificationId","verificationNonce","verificationTaskId"].map(k=>[k,lock.physicalCleanup.verification[k]]));const c=await call("challenge",{binding,...fields});return {t,fields,challenge:c.challenge};}
  function proof(r){return {binding,...r.fields,challenge:r.challenge,snapshots:[1,2].map(i=>({sequence:i,elapsedMs:i*100,observedAt:new Date(wall+offset).toISOString(),packagesAbsent:true,packageNames:[...WECOM_PACKAGES],serialForwardCount:0}))};}
  return {state,task,job,businessLock,lock,binding,bootstrap,hosts,close,service,options,clock,call,ready,proof,saved,
    advance:ms=>{mono+=BigInt(ms)*1000000n;},wallShift:ms=>{wall+=ms;},write:fn=>{writer=fn;}};
}
for(const offset of [-300000,-300,300,300000])test(`real service flow ignores cross-machine UTC offset ${offset}`,async()=>{const f=fixture(offset),r=await f.ready();f.advance(2999);const p=f.proof(r);assert.equal(f.service.lease("fixture-agent",f.lock.lockId,r.fields),true);assert.equal((await f.call("proof",p)).verified,true);assert.equal(f.lock.status,"released");assert.equal(r.t.status,"succeeded");assert.equal((await f.call("proof",p)).reused,true);});
test("service accepts exact3s and rejects3s+1ms without releasing",async()=>{for(const ms of [3000,3001]){const f=fixture(),r=await f.ready();f.advance(ms);if(ms===3000)assert.equal((await f.call("proof",f.proof(r))).verified,true);else{await assert.rejects(f.call("proof",f.proof(r)),/causal_context/);assert.equal(f.lock.status,"cleanup_pending");}}});
test("request queued at same device gate does not inherit an early receipt time",async()=>{const f=fixture(),r=await f.ready(),gate=deferred(),entered=deferred();let once=true;f.write(async()=>{if(once){once=false;entered.resolve();await gate.promise;}});const close=f.call("host-closed",f.close);await entered.promise;const waiting=f.call("proof",f.proof(r));f.advance(3001);gate.resolve();await close;await assert.rejects(waiting,/causal_context/);assert.equal(f.lock.status,"cleanup_pending");});
test("asynchronous storage retains committing/checkpoint fence until known completion",async()=>{const f=fixture(),r=await f.ready(),gate=deferred(),entered=deferred();f.write(async()=>{entered.resolve();await gate.promise;});const pending=f.call("proof",f.proof(r));await entered.promise;assert.equal(f.lock.status,"released");assert.equal(f.service.pending(f.task.deviceId).status,"cleanup_pending");assert.equal(f.service.canPick({deviceId:f.task.deviceId,type:"alipay_name_query"}),false);assert.equal(f.service.canPick({deviceId:"adb:other",type:"alipay_name_query"}),true);const checkpoint=f.service.checkpoint(structuredClone(f.state));assert.equal(checkpoint.deviceLocks.find(l=>l.lockId===f.lock.lockId).status,"cleanup_pending");f.advance(90000);gate.resolve();await pending;assert.equal(f.service.pending(f.task.deviceId),null);});
test("persist failure after candidate rolls back and never opens device",async()=>{const f=fixture(),r=await f.ready();f.write(async()=>{throw Error("synthetic-lost-storage-reply");});await assert.rejects(f.call("proof",f.proof(r)),/storage_unavailable/);assert.equal(f.lock.status,"cleanup_pending");assert.equal(r.t.status,"running");assert.ok(f.service.pending(f.task.deviceId));f.write(async()=>{});f.advance(3001);await assert.rejects(f.call("proof",f.proof(r)),/causal_context/);});
test("new service epoch cannot restore old ticket from wall or automatically verify old duty",async()=>{const f=fixture(),r=await f.ready();const fresh=createWecomCleanupService({...f.options,clock:createWecomCausalClock({epoch:"epoch-two"})});assert.equal(fresh.canPick(r.t),false);assert.equal(await fresh.reconcile("fixture-agent"),null);await assert.rejects(fresh.handle("fixture-agent",f.lock.lockId,"proof",f.proof(r)),/causal_context/);assert.equal(f.lock.status,"cleanup_pending");});
test("legacy original obligation with missing host remains isolated without fabricated upgrade",async()=>{const f=fixture();delete f.lock.physicalCleanup.causal;const before=structuredClone(f.lock);await assert.rejects(f.call("host",{binding:f.binding,hosts:f.hosts,bootstrap:f.bootstrap}),/causal_context/);assert.deepEqual(f.lock,before);assert.equal(await f.service.reconcile("fixture-agent"),null);});
for(const key of ["pipeNonce","bindingNonce","protocol"])test(`bootstrap drift rejected: ${key}`,async()=>{const f=fixture();await f.call("host",{binding:f.binding,hosts:f.hosts,bootstrap:f.bootstrap});const bootstrap={...f.bootstrap,[key]:"changed"};await assert.rejects(f.call("host",{binding:f.binding,hosts:f.hosts,bootstrap}),/host_unconfirmed|binding_mismatch/);await assert.rejects(f.call("host-closed",{...f.close,bootstrap}),/host_unconfirmed/);assert.ok(f.service.pending(f.task.deviceId));});
test("business payload drift and attempts to restart300s lease fail closed",()=>{const f=fixture();assert.throws(()=>f.service.bindBusinessLease(f.service.beginBusinessLease(),f.task,f.job,f.businessLock),/causal_context/);f.task.payload.phoneNumber=f.job.phoneNumber="13900000001";assert.equal(f.service.businessRemaining(f.task),0);assert.equal(f.service.originalReady(f.task),false);});
test("new challenge request does not reset old3s",async()=>{const f=fixture(),r=await f.ready();f.advance(3001);const repeated=await f.call("challenge",{binding:f.binding,...r.fields});assert.deepEqual(repeated.challenge,r.challenge);await assert.rejects(f.call("proof",f.proof(r)),/causal_context/);});
test("proof semantic, scope, replay sequence and unknown fields reject before release",async()=>{for(const change of [p=>p.snapshots[1].sequence=1,p=>p.snapshots[1].elapsedMs=p.snapshots[0].elapsedMs,p=>p.snapshots[0].packagesAbsent=false,p=>p.snapshots[0].serialForwardCount=1,p=>p.challenge.challengeId="old",p=>p.extra=true]){const f=fixture(),r=await f.ready(),p=f.proof(r);change(p);await assert.rejects(f.call("proof",p),/proof_invalid|causal_context/);assert.equal(f.lock.status,"cleanup_pending");}});
test("wall jumps cannot extend or expire original monotonic business lease",()=>{const f=fixture();f.wallShift(86400000);assert.equal(f.service.expireTask(f.task),false);assert.deepEqual(f.service.businessLockState(f.businessLock),{known:true,remainingMs:300000});f.advance(300000);assert.equal(f.service.expireTask(f.task),true);assert.equal(f.task.status,"failed");assert.equal(f.lock.status,"cleanup_pending");});
test("missing epoch is stalled without clearing hold or requeue",()=>{const f=fixture();const fresh=createWecomCleanupService({...f.options,clock:createWecomCausalClock({epoch:"epoch-two"})});assert.equal(fresh.expireTask(f.task),true);assert.equal(f.task.status,"stalled");assert.equal(f.task.recoverable,false);assert.equal(f.lock.status,"cleanup_pending");assert.equal(fresh.canPick(f.task),false);});

test("known durable proof retires original contexts and stored exact proof still ACKs after epoch loss",async()=>{
  const f=fixture(),r=await f.ready(),p=f.proof(r);assert.equal(f.clock.counts().leases,2);await f.call("proof",p);
  assert.deepEqual(f.clock.counts(),{capacity:1024,business:0,verification:0,marks:0,leases:0,challenges:0});
  assert.equal((await f.call("proof",p)).reused,true);
  const restored=createWecomCleanupService({...f.options,clock:createWecomCausalClock({epoch:"next-epoch"})});
  assert.equal((await restored.handle("fixture-agent",f.lock.lockId,"proof",structuredClone(p))).reused,true);
  await assert.rejects(restored.handle("fixture-agent",f.lock.lockId,"proof",{...p,verificationNonce:"other"}),/proof_invalid/);
});
test("pending or unknown persistence cannot retire any original context",async()=>{
  const f=fixture(),r=await f.ready(),gate=deferred(),entered=deferred(),before=f.clock.counts();
  f.write(async()=>{entered.resolve();await gate.promise;throw Error("synthetic-commit-unknown");});
  const pending=f.call("proof",f.proof(r));await entered.promise;assert.deepEqual(f.clock.counts(),before);assert.ok(f.service.pending(f.task.deviceId));
  gate.resolve();await assert.rejects(pending,/storage_unavailable/);assert.deepEqual(f.clock.counts(),before);assert.equal(f.lock.status,"cleanup_pending");
});
test("another unresolved physical duty retains bounded authority even after this proof commits",async()=>{
  const f=fixture(),r=await f.ready(),before=f.clock.counts();
  f.state.deviceLocks.push({lockId:"another-original-duty",deviceId:f.task.deviceId,lockType:"wecom_physical_cleanup",status:"cleanup_pending",physicalCleanup:{legacySerial:f.task.adbSerial}});
  await f.call("proof",f.proof(r));assert.deepEqual(f.clock.counts(),before);assert.ok(f.service.pending(f.task.deviceId));
});
test("repeated normally completed service lifecycles do not accumulate clock entries",async()=>{
  let n=0;const clock=createWecomCausalClock({mono:()=>0n,id:()=>`id-${++n}`,epoch:"reused-service-clock",capacity:1});
  for(let i=0;i<100;i++){
    const f=fixture(0,clock),r=await f.ready();await f.call("proof",f.proof(r));assert.equal(clock.counts().leases,0);assert.equal(clock.counts().challenges,0);assert.equal(clock.counts().marks,0);
  }
});
