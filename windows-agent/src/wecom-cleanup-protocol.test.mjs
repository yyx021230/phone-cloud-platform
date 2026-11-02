import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {physicalBinding,physicalHosts,createPhysicalLifecycle,submitSamePhysicalProof} from './wecom-cleanup-protocol.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('../../verification/wecom-cleanup-v1/fixtures.json',import.meta.url)));
const binding=fixtures.binding;
const config={agentId:binding.agentId,serverBaseUrl:'http://127.0.0.1:1',agentToken:'fixture-only'};
const task={taskId:binding.originalTaskId,agentId:binding.agentId,deviceId:binding.deviceId,adbSerial:binding.serial,payload:{physicalCleanup:binding,appSlot:binding.appSlot,androidUser:binding.androidUser}};

test('fixed fixture binding is exact and cannot inherit another task or Agent',()=>{
  assert.deepEqual(physicalBinding(task,config),binding);
  for(const key of ['originalTaskId','deviceId','serial','agentId','appSlot','androidUser']){
    const copy=structuredClone(task);copy.payload.physicalCleanup[key]=key==='androidUser'?999:'other';
    assert.throws(()=>physicalBinding(copy,config),/binding_mismatch/);
  }
  const copy=structuredClone(task);copy.payload.physicalCleanup.phoneNumber='must never be present';
  assert.throws(()=>physicalBinding(copy,config),/binding_mismatch/);
});
test('exact creation precision, machine and only actual task host roles are required',()=>{
  assert.deepEqual(physicalHosts(fixtures.host.hosts),fixtures.host.hosts);
  for(const [key,value]of [['creationToken','0x1.abcdefp+30'],['machineId','wrong'],['role','agent'],['pid',true],['createdAt','private']]){
    const h=structuredClone(fixtures.host.hosts);h[0][key]=value;
    assert.throws(()=>physicalHosts(h),/host_invalid/);
  }
  const hosts=Array.from({length:8},(_,i)=>({...fixtures.host.hosts[0],role:i?'worker_'+i:'reader',pid:100+i}));
  assert.equal(physicalHosts(hosts).length,8);
  assert.throws(()=>physicalHosts([...hosts,{...hosts[0],pid:900}]),/host_invalid/);
});
test('historical ID case is retained while the corrected actual selector stays exact',()=>{
  const copy=structuredClone(task);copy.deviceId=copy.payload.physicalCleanup.deviceId='adb:FIXTURE';
  assert.equal(physicalBinding(copy,config).deviceId,'adb:FIXTURE');assert.equal(physicalBinding(copy,config).serial,'fixture');
  const mismatch=structuredClone(copy);mismatch.adbSerial='FIXTURE';
  assert.throws(()=>physicalBinding(mismatch,config),/binding_mismatch/);
  copy.deviceId=copy.payload.physicalCleanup.deviceId='adb:other';assert.throws(()=>physicalBinding(copy,config),/binding_mismatch/);
});
test('ready must bind the actual OS child and cannot invent a wrapper exit requirement',async()=>{
  for(const hosts of [[{...fixtures.host.hosts[0],pid:999}],[...fixtures.host.hosts,{...fixtures.host.hosts[0],role:'wrapper',pid:200}]]){
    let calls=0;const life=createPhysicalLifecycle(task,{config,request:async()=>{calls++;return{ok:true};}});
    await assert.rejects(life.ready({version:1,hosts},124),/host_invalid/);assert.equal(calls,0);
  }
});
test('host registration ACK precedes release; close cannot be fabricated by final JSON',async()=>{
  const calls=[];let acknowledge;
  const life=createPhysicalLifecycle(task,{config,wall:()=>fixtures.hostClosed.observedAt,request:async(route,{body})=>{
    calls.push({route,body});if(route.endsWith('/host'))await new Promise(r=>acknowledge=r);return{ok:true};
  }});
  let done=false;const ready=life.ready({version:1,hosts:fixtures.host.hosts},124).then(()=>done=true);
  await Promise.resolve();assert.equal(done,false);assert.equal(calls.length,1);
  acknowledge();await ready;assert.equal(done,true);
  await life.closed();assert.deepEqual(calls[1].body,fixtures.hostClosed);
  await life.closed();assert.equal(calls.length,2);
});
test('duplicate ready and mismatched precision are rejected without another grant',async()=>{
  const life=createPhysicalLifecycle(task,{config,request:async()=>({ok:true})});
  await life.ready({version:1,hosts:fixtures.host.hosts},124);
  await assert.rejects(life.ready({version:1,hosts:fixtures.host.hosts},124),/host_invalid/);
});
test('host and close each retry the exact body once for lost ACK only',async()=>{
  const bodies={host:[],close:[]};let wallCalls=0;
  const life=createPhysicalLifecycle(task,{config,wall:()=>{wallCalls++;return fixtures.hostClosed.observedAt;},request:async(route,{body})=>{
    const rows=route.endsWith('/host')?bodies.host:bodies.close;rows.push(structuredClone(body));
    if(rows.length===1)throw Object.assign(Error('lost'),{deliveryUnknown:true});return{ok:true};
  }});
  await life.ready({version:1,hosts:fixtures.host.hosts},124);await life.closed();
  assert.deepEqual(bodies.host,[fixtures.host,fixtures.host]);assert.deepEqual(bodies.close,[fixtures.hostClosed,fixtures.hostClosed]);assert.equal(wallCalls,1);
});
test('permanent close uncertainty and exhausted original budget stay pending',async()=>{
  let closeCalls=0;
  const life=createPhysicalLifecycle(task,{config,request:async route=>{
    if(route.endsWith('/host'))return{ok:true};closeCalls++;throw Object.assign(Error('lost'),{deliveryUnknown:true});
  }});
  await life.ready({version:1,hosts:fixtures.host.hosts},124);await assert.rejects(life.closed());assert.equal(closeCalls,2);
  const expired=createPhysicalLifecycle(task,{config,remainingMs:()=>0,request:async()=>assert.fail('no request after budget')});
  await assert.rejects(expired.ready({version:1,hosts:fixtures.host.hosts},124),/budget_exhausted/);
});
test('lost proof response retries the same original bytes without restamping or rereading',async()=>{
  const bodies=[];const original=structuredClone(fixtures.proof);
  const result=await submitSamePhysicalProof(binding,original,{request:async(route,{body})=>{
    bodies.push(structuredClone(body));body.snapshots[0].observedAt='mutated';
    original.snapshots[1].observedAt='caller mutated';
    if(bodies.length===1)throw Object.assign(Error('private'),{deliveryUnknown:true});return{ok:true,verified:true,reused:true};
  }});
  assert.equal(result.verified,true);assert.deepEqual(bodies,[fixtures.proof,fixtures.proof]);
});
test('two unknown proof ACKs retain unknown; known rejection does not trigger a new proof',async()=>{
  let calls=0;
  await assert.rejects(submitSamePhysicalProof(binding,fixtures.proof,{request:async()=>{calls++;throw Object.assign(Error('private'),{deliveryUnknown:true});}}),e=>e.proofDeliveryUnknown===true);
  assert.equal(calls,2);calls=0;
  await assert.rejects(submitSamePhysicalProof(binding,fixtures.proof,{request:async()=>{calls++;throw Error('wecom_cleanup_proof_invalid');}}),/proof_invalid/);
  assert.equal(calls,1);
});
