import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set(),screens=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={screenActive:c=>screens.has(c.deviceId),clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000',resumeHuman:async target=>{if(await service.beforeResume(target.sessionId)){events.push({kind:'resume',device:target.deviceId});obs.set(target.deviceId,{busy:true});return true;}return false;}});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,preparedClientInflightLimit:100,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},adapter,screens,store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000',resumeHuman:async target=>{if(await service.beforeResume(target.sessionId)){events.push({kind:'resume',device:target.deviceId});return true;}return false;}});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

async function allReady(f){await f.prepare();await f.service.tick();const cs=f.store.snapshot().channels;for(const c of cs){await f.readyStart(c);await f.result(c);}return f.store.snapshot().channels;}
const proof=c=>({sessionId:c.sessionId,deviceId:c.deviceId,challengeId:'challenge-'+c.sessionId,screenSessionId:''});
test('zero business and four puzzles never expand physical reservations',async()=>{
 const f=fixture();await f.configure();await f.prepare();await f.service.tick();
 for(const c of f.store.snapshot().channels.slice(0,4))f.obs.set(c.deviceId,{human:true});
 await f.service.tick();assert.equal(f.store.snapshot().channels.length,5);assert.equal(f.events.filter(e=>e.kind==='start').length,5);
});
test('confirmed human gets next slot ahead of queued business and fresh probing; stale/cancelled proof cannot resume',async()=>{
 const f=fixture();await f.configure();const cs=await allReady(f);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{human:true});await f.service.tick();await f.service.recordHumanObservation(proof(c),{state:'search_ready',confirmed:true});
 const next=await f.submit('another-request-key','13900000001');await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,1);assert.ok(f.service.admin().counts.executing<=5);
 const seq=f.events.filter(e=>['resume','query'].includes(e.kind));assert.ok(seq.findIndex(e=>e.kind==='resume')<seq.findIndex(e=>e.id===next.lookupId));
 await f.service.cancel(r.lookupId,'test');await f.service.tick();assert.equal(await f.service.recordHumanObservation(proof(c),{state:'search_ready',confirmed:true}),false);
});
test('50 sequential submissions distribute evenly across five ready idle phones',async()=>{
 const f=fixture();await f.configure();await allReady(f);const counts={};
 for(let i=0;i<50;i++){const r=await f.submit('balanced-key-'+i,'1390001'+String(i).padStart(4,'0'));await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);counts[c.deviceId]=(counts[c.deviceId]||0)+1;await f.result(c);}
 assert.deepEqual(Object.values(counts).sort(),[10,10,10,10,10]);
});
test('50 queued requests continue on healthy phones while one needs human, no duplicate canonical query',async()=>{
 const f=fixture();await f.configure();const cs=await allReady(f);
 const rows=await Promise.all(Array.from({length:50},(_,i)=>f.submit('parallel-queue-'+i,'1390002'+String(i).padStart(4,'0'))));await f.service.tick();
 f.obs.set(cs[0].deviceId,{human:true});f.screens.add(cs[0].deviceId);await f.service.tick();
 let guard=0;while(guard++<60){const running=f.store.snapshot().channels.filter(c=>c.phase==='querying');if(!running.length)break;for(const c of running)await f.result(c);assert.ok(f.store.snapshot().channels.length<=5);assert.ok(f.service.admin().counts.executing<=5);}
 assert.equal(f.store.snapshot().requests.filter(r=>rows.some(x=>x.lookupId===r.lookupId)&&r.status==='succeeded').length,49);
 const original=f.store.snapshot().requests.find(r=>r.status==='waiting_human'&&r.purpose!=='readiness_probe');f.advance(121000);assert.equal((await f.submit('retry-after-timeout',original.phoneNumber)).lookupId,original.lookupId);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===original.lookupId).length,1);
});
test('human replacement waits two minutes and stop ACK; active control is never stopped',async()=>{
 const f=fixture();await f.configure();const cs=await allReady(f);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.obs.set(c.deviceId,{human:true});await f.service.tick();
 f.advance(119999);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='stop').length,0);f.screens.add(c.deviceId);f.advance(2);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='stop').length,0);
 f.screens.delete(c.deviceId);f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};await f.service.tick();assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).status,'rerouting');
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);assert.equal(f.store.snapshot().channels.length,5);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,2);assert.ok(f.store.snapshot().channels.length<=5);
});
test('confirmed account limit repairs original phone before opening unused standby',async()=>{
 const f=fixture();await f.configure();await allReady(f);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();await f.service.tick();await f.service.tick();
 assert.ok(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length===2);assert.equal(f.events.filter(e=>e.kind==='start'&&e.device==='d138').length,0);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,2);
});

test('full legacy execution capacity does not lose confirmed human proof and releases next slot to it',async()=>{
 const f=fixture();await f.configure();const cs=await allReady(f);const rows=await Promise.all(Array.from({length:5},(_,i)=>f.submit('capacity-business-'+i,'1390003'+String(i).padStart(4,'0'))));await f.service.tick();
 const c=f.store.snapshot().channels[0];f.obs.set(c.deviceId,{human:true});await f.service.tick();
 await f.store.transact(s=>s.channels.push({deviceId:'legacy-busy',sessionId:'legacy',generation:'legacy',phase:'unknown'}));
 await f.service.recordHumanObservation(proof(c),{state:'search_ready',confirmed:true});await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).humanObservation.confirmed,true);
 const free=f.store.snapshot().channels.find(x=>x.phase==='querying');await f.result(free);assert.equal(f.events.filter(e=>e.kind==='resume').length,1);assert.ok(f.service.admin().counts.executing<=5);
});
test('stale confirmation and restarted coordinator cannot reuse old positive observations',async()=>{
 const f=fixture();await f.configure();await allReady(f);await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId);f.obs.set(c.deviceId,{human:true});await f.service.tick();
 await f.service.recordHumanObservation(proof(c),{state:'search_ready',confirmed:true});f.advance(30001);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);
 await f.service.recordHumanObservation(proof(c),{state:'search_ready',confirmed:true});f.restart();assert.equal(f.service.reserved(c.deviceId).humanObservation,undefined);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);
});

for(const state of ['account_limited','login_required','recoverable_page'])test('post-human '+state+' schedules fresh inspection once and does not seize controls',async()=>{
 const f=fixture();await f.configure();await allReady(f);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{human:true});await f.service.tick();await f.service.recordHumanObservation(proof(c),{state,confirmed:true});f.screens.add(c.deviceId);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);
 f.screens.delete(c.deviceId);await f.service.tick();await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,1);assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).lookupId,r.lookupId);assert.ok(f.service.admin().counts.executing<=5);
});
for(const state of ['unknown','loading','network_busy'])test('continuous '+state+' waits 60 seconds then gets bounded inspection; other phone continues',async()=>{
 const f=fixture();await f.configure();await allReady(f);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.obs.set(c.deviceId,{human:true});await f.service.tick();
 for(let i=0;i<6;i++){await f.service.recordHumanObservation(proof(c),{state,confirmed:false,reason:'page_unknown'});await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);f.advance(10000);}
 const r2=await f.submit('other-phone-request','13900000001');await f.service.tick();assert.ok(f.events.some(e=>e.kind==='query'&&e.id===r2.lookupId&&e.device!==c.deviceId));
 await f.service.recordHumanObservation(proof(c),{state,confirmed:false,reason:'page_unknown'});await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,1);
});
test('unknown dwell cannot borrow another challenge, read gap, or busy state',async()=>{
 const f=fixture();await f.configure();await allReady(f);await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId);f.obs.set(c.deviceId,{human:true});await f.service.tick();
 await f.service.recordHumanObservation(proof(c),{state:'unknown',reason:'page_unknown'});f.advance(60000);await f.service.recordHumanObservation(proof(c),{state:'unknown',reason:'page_unknown'});await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='resume').length,0);
 for(let i=0;i<7;i++){f.advance(10000);await f.service.recordHumanObservation({...proof(c),challengeId:'different'},{state:'unknown',reason:'device_busy'});await f.service.tick();}assert.equal(f.events.filter(e=>e.kind==='resume').length,0);
});

test('post-human unknown probe backs off without marking account offline or adding preparation failures',async()=>{
 const f=fixture();await f.configure();await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];
 f.obs.set(c.deviceId,{recovery:true,postHumanPageUnknown:true,recoveryFailure:{domain:'page'}});await f.service.tick();
 const s=f.store.snapshot(),r=s.requests.find(r=>r.lookupId===c.requestId),d=s.devices.find(d=>d.deviceId===c.deviceId);
 assert.equal(r.code,'lookup_probe_page_unsupported');assert.equal(Boolean(d.accountOffline),false);assert.ok(d.quarantineUntil>Date.now());assert.equal(d.consecutivePreparationFailures||0,0);assert.ok(f.events.some(e=>e.kind==='stop'&&e.device===c.deviceId));
});
