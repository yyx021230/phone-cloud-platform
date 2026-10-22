import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {manualResults} from './lookup-manual-result.mjs';
const at = '2026-10-22T08:00:00.000Z', actor = 'authorized-operator';
const entry = {lookupId:'original',expectedQueryId:'original-query',expectedPhoneNumber:'13900000000',name:'测试(*名)',evidenceSha256:'a'.repeat(64)};
const fixture = () => ({version:1,revision:3,config:{enabled:true,concurrency:5},grants:[{clientId:'client',enabled:true}],devices:[],audits:[],requests:[{lookupId:'original',queryId:'original-query',clientId:'client',idempotencyKey:'original-key',phoneNumber:'13900000000',fingerprint:'test-fingerprint',status:'needs_recovery',mode:'async',resultProtocol:'prepared-v1',executionDeadline:Date.parse(at)+3600000,createdAt:at,attempts:[]},{lookupId:'unrelated',status:'succeeded',name:'保留',completedAt:at}],channels:[{deviceId:'device',deviceNumber:112,generation:'generation',sessionId:'session',clientId:'client',requestId:'original',queryId:'original-query',phase:'recovery',readinessProof:{old:true}}]});
test('manual fill preserves original identity, other results and physical reservation', () => {
  const s=fixture(), copy=structuredClone(s), {next,before}=manualResults(s,[entry],{actor,at});
  assert.deepEqual(s,copy); assert.deepEqual(before[0].request,s.requests[0]);
  assert.deepEqual(next.requests[1],s.requests[1]); assert.equal(next.requests[0].queryId,'original-query');
  assert.equal(next.requests[0].status,'succeeded'); assert.equal(next.requests[0].cancelReason,'lookup_manual_result_cleanup');
  assert.equal(next.channels[0].requestId,'original'); assert.equal(next.channels[0].phase,'recovery');
  assert.equal(next.channels[0].readinessProof,undefined); assert.equal(next.audits[0].action,'lookup_manual_result_recorded');
});
for (const mode of ['wrongPhone','wrongQuery','busy','unknown','alreadyDone','cancelled','roundStopping','duplicate','probe','badEvidence']) test('rejects '+mode+' without modifying state',()=>{
  const s=fixture(),e={...entry};
  if(mode==='wrongPhone')e.expectedPhoneNumber='13900000001';
  if(mode==='wrongQuery')e.expectedQueryId='different';
  if(mode==='busy'){s.requests[0].status='running';s.channels[0].phase='querying';}
  if(mode==='unknown')s.channels[0].phase='unknown';
  if(mode==='alreadyDone')s.requests[0].status='succeeded';
  if(mode==='cancelled')s.requests[0].cancelRequested=true;
  if(mode==='roundStopping')s.channels[0].roundStopPreparationId='round';
  if(mode==='probe')s.requests[0].purpose='readiness_probe';
  if(mode==='badEvidence')e.evidenceSha256='';
  const copy=structuredClone(s);assert.throws(()=>manualResults(s,mode==='duplicate'?[e,e]:[e],{actor,at}));assert.deepEqual(s,copy);
});
for(const originalState of ['recovery','human'])test('deployed coordinator keeps manual result, stops once, waits for ACK and releases '+originalState,async()=>{
  if(!process.env.LOOKUP_RUNTIME_DIR)throw Error('Set LOOKUP_RUNTIME_DIR to the hash-verified deployed assembly');
  const {createManagedLookupService}=await import(pathToFileURL(path.join(process.env.LOOKUP_RUNTIME_DIR,'server/managed-lookup.mjs')));
  let state=fixture();if(originalState==='human'){state.channels[0].phase='human';state.requests[0].status='waiting_human';}
  state=manualResults(state,[entry],{actor,at}).next;
  const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id)=>structuredClone(state.requests.find(r=>r.lookupId===id)),transact:async(fn)=>{const next=structuredClone(state);const result=await fn(next,{onRollback:()=>{},onCommit:()=>{}});state=next;return result;}};
  let observation=originalState==='human'?{human:true}:{recovery:true,ready:true},stops=0;
  const adapter={observe:()=>observation,canStop:()=>true,health:()=>({ready:true}),clientValid:()=>true,stop:async()=>{stops++;observation={busy:true};},query:async()=>{throw Error('must_not_query_again');},start:async()=>{throw Error('must_not_start_original');}};
  const service=createManagedLookupService({store,adapter,now:()=>Date.parse(at)});
  const before=await service.getAsyncResult('original','client');assert.equal(before.name,entry.name);assert.equal(before.status,'completed');
  await service.tick();assert.equal(stops,1);assert.equal(state.channels[0].phase,'stopping');
  await service.tick();assert.equal(stops,1);assert.equal(state.channels.length,1);
  observation={stopped:true,result:{resultId:'original-query',status:'succeeded',name:'late-value'}};
  await service.tick();assert.equal(state.channels.length,0);assert.equal((await service.getAsyncResult('original','client')).name,entry.name);
  assert.equal(state.requests[1].name,'保留');
});
test('already handed-off queued original can be completed before another dispatch, with exact last attempt proof',()=>{
  const s=fixture();s.channels=[];s.requests[0].status='queued';delete s.requests[0].queryId;s.requests[0].attempts=[{sessionId:'session',deviceId:'device'}];
  const e={...entry,expectedSessionId:'session',expectedDeviceId:'device',expectedAttemptCount:1};
  const {next}=manualResults(s,[e],{actor,at});assert.equal(next.requests[0].status,'succeeded');assert.equal(next.requests[0].cancelRequested,undefined);assert.equal(next.channels.length,0);
  for(const bad of [{expectedAttemptCount:2},{expectedSessionId:'new-session'},{expectedDeviceId:'other'}])assert.throws(()=>manualResults(s,[{...e,...bad}],{actor,at}));
  s.channels=fixture().channels;assert.throws(()=>manualResults(s,[e],{actor,at}));
});
