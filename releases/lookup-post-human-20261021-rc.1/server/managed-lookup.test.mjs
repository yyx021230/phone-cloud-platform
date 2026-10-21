import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';
import {initialManagedLookupState,LOOKUP_POOL_NUMBERS} from './managed-lookup-store.mjs';

function fixture(){
  let state=initialManagedLookupState(), clock=1000;
  const events=[], observations=new Map(), unhealthy=new Set();
  const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>state.requests.find(r=>r.lookupId===id&&r.clientId===client),close:async()=>{},transact:async fn=>{const next=structuredClone(state);const result=await fn(next,{archived:async()=>null,onRollback:()=>{}});state=next;return result;}};
  const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!unhealthy.has(id)}),canStop:c=>!unhealthy.has(c.deviceId),resolveNumber:()=>{},observe:c=>observations.get(c.deviceId)||{busy:true},start:async(c,r)=>{c.sessionId='session-'+c.deviceId;events.push({kind:'start',client:r.clientId,id:r.lookupId,device:c.deviceId});},query:async(c,r)=>{r.queryId=c.queryId='query-'+r.lookupId;events.push({kind:'query',id:r.lookupId,device:c.deviceId});},stop:async c=>events.push({kind:'stop',device:c.deviceId})};
  const service=createManagedLookupService({store,adapter,now:()=>clock});
  const configure=()=>service.configure({enabled:true,devices:LOOKUP_POOL_NUMBERS.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:['a','b'].map(clientId=>({clientId,enabled:true,consentReference:'fixture-consent'}))},'test');
  const submit=(client,key)=>service.submit({clientId:client,phoneNumber:'13800000000',key:'fixture-'+key});
  return {service,store,events,observations,unhealthy,configure,submit,advance:n=>clock+=n};
}

test('two clients share five slots fairly, FIFO and unknown execution retains reservations',async()=>{
  const f=fixture();await f.configure();const a=[],b=[];for(let i=0;i<5;i++)a.push(await f.submit('a','a'+i));for(let i=0;i<5;i++)b.push(await f.submit('b','b'+i));await f.service.tick();
  assert.deepEqual(f.events.map(e=>e.client),['a','b','a','b','a']);assert.deepEqual(f.events.filter(e=>e.client==='a').map(e=>e.id),a.slice(0,3));assert.deepEqual(f.events.filter(e=>e.client==='b').map(e=>e.id),b.slice(0,2));assert.equal(new Set(f.events.map(e=>e.device)).size,5);
  for(const c of f.store.snapshot().channels)f.observations.set(c.deviceId,{unknown:true});await f.service.tick();assert.equal(f.events.length,5);assert.equal(f.service.admin().counts.executing,5);await f.service.close();
});

test('human resume cannot exceed five or bypass cancellation, revocation or unhealthy Agent',async()=>{
  const f=fixture();await f.configure();for(let i=0;i<6;i++)await f.submit('a','human'+i);await f.service.tick();const first=f.store.snapshot().channels[0];f.observations.set(first.deviceId,{human:true});await f.service.tick();assert.equal(f.store.snapshot().channels.length,5);await f.store.transact(s=>s.channels.push({deviceId:'legacy-extra',sessionId:'legacy',phase:'unknown'}));assert.equal(await f.service.beforeResume(first.sessionId),false);
  await f.store.transact(s=>{s.channels[1].phase='idle';});f.unhealthy.add(first.deviceId);assert.equal(await f.service.beforeResume(first.sessionId),false);f.unhealthy.clear();await f.service.cancel(first.requestId,'test');assert.equal(await f.service.beforeResume(first.sessionId),false);
  await f.store.transact(s=>{s.requests.find(r=>r.lookupId===first.requestId).cancelRequested=false;s.grants[0].enabled=false;});assert.equal(await f.service.beforeResume(first.sessionId),false);await f.service.close();
});

test('offline cancellation holds the phone while healthy phones continue',async()=>{
  const f=fixture();await f.configure();const id=await f.submit('a','cancel1');await f.service.tick();const c=f.store.snapshot().channels[0];await f.service.cancel(id,'test');f.unhealthy.add(c.deviceId);await f.submit('b','next1');await f.service.tick();assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'unknown');assert.equal(f.events.filter(e=>e.kind==='start').length,2);assert.equal(f.events.filter(e=>e.kind==='stop').length,0);await f.service.close();
});

test('preparation migrates once before query; backoff survives configuration edits',async()=>{
  const f=fixture();await f.configure();const id=await f.submit('a','prepare1');await f.service.tick();const first=f.store.snapshot().channels[0];f.observations.set(first.deviceId,{startFailed:true,stopped:true});await f.service.tick();const second=f.store.snapshot().channels[0];assert.notEqual(second.deviceId,first.deviceId);assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===id).attempts.length,2);
  f.observations.set(second.deviceId,{startFailed:true,stopped:true});await f.service.tick();assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===id).status,'failed');await f.configure();await f.submit('a','prepare2');await f.service.tick();assert.ok(![first.deviceId,second.deviceId].includes(f.events.at(-1).device));assert.equal(f.events.filter(e=>e.kind==='query').length,0);assert.equal(f.service.admin().devices.find(d=>d.deviceId===first.deviceId).health.reason,'preparation_backoff');await f.service.close();
});

test('queue limits, conflicting keys and terminal replay do not multiply work',async()=>{
  const f=fixture();await f.configure();await f.service.configure({clientQueueLimit:1,queueLimit:2},'test');const id=await f.submit('a','bounded1');assert.equal(await f.submit('a','bounded1'),id);await assert.rejects(f.submit('a','bounded2'),/lookup_queue_full/);await assert.rejects(f.service.submit({clientId:'a',phoneNumber:'13900000000',key:'fixture-bounded1'}),/idempotency_conflict/);await f.service.cancel(id,'test');assert.deepEqual(await f.service.wait(id,'a'),{status:503,body:{ok:false,name:'',code:'lookup_cancelled'}});assert.equal(f.events.length,0);await f.service.close();
});


test('startup human handover keeps the original request and dispatches its first query after busy start',async()=>{
  const f=fixture();await f.configure();const id=await f.submit('a','startup-human');await f.service.tick();const c=f.store.snapshot().channels[0];
  f.observations.set(c.deviceId,{human:true});await f.service.tick();await f.service.recordHumanObservation({sessionId:c.sessionId,deviceId:c.deviceId,challengeId:'fixture',screenSessionId:''},{state:'search_ready',confirmed:true});assert.equal(await f.service.beforeResume(c.sessionId),true);
  f.observations.set(c.deviceId,{busy:true});await f.service.tick();f.observations.set(c.deviceId,{ready:true});await f.service.tick();await f.service.tick();
  const queries=f.events.filter(e=>e.kind==='query');assert.equal(queries.length,1);assert.equal(queries[0].id,id);assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===id).attempts.length,1);await f.service.close();
});

test('persisted post-start handover with no query id can continue without preparing again',async()=>{
  const f=fixture();await f.configure();const id=await f.submit('a','persisted-start');await f.service.tick();const c=f.store.snapshot().channels[0];
  await f.store.transact(s=>{s.channels[0].phase='querying';s.requests[0].status='running';});f.observations.set(c.deviceId,{ready:true});await f.service.tick();
  assert.equal(f.events.filter(e=>e.kind==='query').length,1);assert.equal(f.events.filter(e=>e.kind==='start').length,1);assert.equal(f.events.at(-1).id,id);await f.service.close();
});

test('query human handover never creates a second query after the original result settles',async()=>{
  const f=fixture();await f.configure();const id=await f.submit('a','query-human');await f.service.tick();const c=f.store.snapshot().channels[0];f.observations.set(c.deviceId,{ready:true});await f.service.tick();
  f.observations.set(c.deviceId,{human:true});await f.service.tick();await f.service.recordHumanObservation({sessionId:c.sessionId,deviceId:c.deviceId,challengeId:'fixture',screenSessionId:''},{state:'search_ready',confirmed:true});assert.equal(await f.service.beforeResume(c.sessionId),true);f.observations.set(c.deviceId,{busy:true});await f.service.tick();
  f.observations.set(c.deviceId,{ready:true,result:{status:'succeeded',name:'fixture'}});await f.service.tick();await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query').length,1);assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===id).status,'succeeded');await f.service.close();
});
