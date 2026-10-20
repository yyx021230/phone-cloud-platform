import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},adapter,store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}
async function recoveredEight(f,{complete=true}={}){
 await f.configure([51,52,54,55,87,138,152,164]);await f.prepare();await f.service.tick();
 const original=f.store.snapshot().channels;
 for(const c of original)await f.readyStart(c);
 for(const c of original.slice(0,3)){f.obs.set(c.deviceId,{human:true});await f.service.tick();}
 const extra=f.store.snapshot().channels.filter(c=>!original.some(o=>o.deviceId===c.deviceId));
 assert.equal(extra.length,3);
 for(const c of extra)await f.readyStart(c);
 for(const c of [...original.slice(3),...extra])await f.result(c);
 if(complete){for(const c of original.slice(0,3)){
   const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);
   f.obs.set(c.deviceId,{ready:true,result:{resultId:current.queryId,status:'succeeded',name:'fixture'}});
  }await f.service.tick();}
 return {original,extra};
}
const live=f=>f.store.snapshot().channels.filter(c=>c.phase!=='stopping');
const stopping=f=>f.store.snapshot().channels.filter(c=>c.phase==='stopping');
async function ackStops(f){for(const c of stopping(f))f.obs.set(c.deviceId,{stopped:true,ready:false});await f.service.tick();}
function delayedStops(f){f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};}
test('recovered phones shrink to five; preserve recovery priority and release only after ACK',async()=>{
 const f=fixture();delayedStops(f);const {original}=await recoveredEight(f);
 assert.equal(f.store.snapshot().channels.length,8);assert.equal(live(f).length,5);assert.equal(stopping(f).length,3);
 for(const c of original.slice(0,3))assert.ok(live(f).some(x=>x.deviceId===c.deviceId));
 const stops=f.events.filter(e=>e.kind==='stop').length;for(let i=0;i<3;i++)await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='stop').length,stops);assert.equal(f.store.snapshot().channels.length,8);
 await ackStops(f);assert.equal(f.store.snapshot().channels.length,5);
 for(const e of f.events.filter(e=>e.kind==='stop'))assert.equal(f.service.reserved(e.device),undefined);
 f.advance(121000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,5);
 assert.equal(f.events.filter(e=>e.kind==='start').length,8);
 assert.ok(f.store.snapshot().requests.filter(r=>r.purpose==='readiness_probe').every(r=>r.status==='succeeded'));
});
test('five active business queries are never stopped to retain recovered spare phones',async()=>{
 const f=fixture();delayedStops(f);const {original}=await recoveredEight(f,{complete:false});
 const jobs=await Promise.all(Array.from({length:8},(_,i)=>f.submit('busy-retain-'+i,'1390000000'+i)));await f.service.tick();
 const busy=f.store.snapshot().channels.filter(c=>jobs.some(j=>j.lookupId===c.requestId));assert.equal(busy.length,5);
 for(const c of original.slice(0,3)){const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);f.obs.set(c.deviceId,{ready:true,result:{resultId:current.queryId,status:'succeeded',name:'fixture'}});}
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='stop').length,0);assert.equal(f.service.admin().counts.executing,5);
 await f.result(busy[0],'business');assert.ok(f.service.admin().counts.executing<=5);
 assert.ok(f.events.filter(e=>e.kind==='stop').every(e=>!busy.some(c=>c.deviceId===e.device)));
 assert.equal((await f.service.getAsyncResult(jobs[0].lookupId,'a')).status,'completed');
 for(let i=1;i<busy.length;i++)await f.result(busy[i],'business');
 await ackStops(f);
 let guard=0;while(f.store.snapshot().requests.some(r=>jobs.some(j=>j.lookupId===r.lookupId)&&r.status!=='succeeded')&&guard++<15){
  const c=f.store.snapshot().channels.find(c=>jobs.some(j=>j.lookupId===c.requestId));if(c)await f.result(c,'business');else await f.service.tick();
  await ackStops(f);assert.ok(f.service.admin().counts.executing<=5);
 }
 for(const j of jobs){assert.equal((await f.service.getAsyncResult(j.lookupId,'a')).status,'completed');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===j.lookupId).length,1);}
 assert.equal(f.store.snapshot().channels.length,5);
});
test('human and unknown reservations remain protected while healthy phones continue',async()=>{
 const f=fixture();const {original}=await recoveredEight(f,{complete:false});
 f.obs.set(original[0].deviceId,{unknown:true});await f.service.tick();
 assert.equal(f.store.snapshot().channels.length,8);assert.equal(f.events.filter(e=>e.kind==='stop').length,0);
 assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===original[0].deviceId).phase,'unknown');
 const j=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===j.lookupId);assert.ok(c);await f.result(c,'business');
 assert.equal((await f.service.getAsyncResult(j.lookupId,'a')).status,'completed');
});
test('five-minute refresh retains the selected five without restarting discarded standbys',async()=>{
 const f=fixture();await recoveredEight(f);await ackStops(f);const selected=live(f).map(c=>({deviceId:c.deviceId,sessionId:c.sessionId}));
 assert.equal(selected.length,5);const starts=f.events.filter(e=>e.kind==='start').length;f.advance(300000);await f.service.tick();
 assert.equal(f.service.admin().counts.executing,5);assert.equal((await f.prepare()).readyCount,0);
 assert.deepEqual(live(f).map(c=>({deviceId:c.deviceId,sessionId:c.sessionId})),selected);
 for(const c of live(f))await f.result(c);assert.equal((await f.prepare()).readyCount,5);assert.equal(f.events.filter(e=>e.kind==='start').length,starts);
});
test('restart keeps surplus stop reservations until ACK; stale proofs cannot admit business',async()=>{
 const f=fixture();delayedStops(f);await recoveredEight(f);const stopped=stopping(f).map(c=>c.deviceId);assert.equal(stopped.length,3);
 f.restart();await f.service.tick();assert.equal(stopping(f).length,3);assert.equal((await f.prepare()).readyCount,0);
 for(const id of stopped)assert.ok(f.service.reserved(id));await ackStops(f);
 for(const id of stopped)assert.equal(f.service.reserved(id),undefined);
 assert.equal(f.store.snapshot().channels.length,5);assert.ok(f.service.admin().counts.executing<=5);
});
test('surplus stop failure rolls back only that phone and does not erase results',async()=>{
 const f=fixture();let fail=true;const stop=f.adapter.stop;f.adapter.stop=async c=>{if(fail)throw Error('stop unavailable');return stop(c);};
 await assert.rejects(recoveredEight(f),/managed_lookup_device_errors/);
 assert.equal(f.store.snapshot().channels.filter(c=>c.phase==='idle').length,8);
 assert.ok(f.store.snapshot().requests.every(r=>r.status==='succeeded'));
 fail=false;await f.service.tick();await ackStops(f);assert.equal(f.store.snapshot().channels.length,5);
});
test('normal five stay warm; unavailable stop leaves reservation and can be retried safely',async()=>{
 const f=fixture();const {original}=await recoveredEight(f,{complete:false});const canStop=f.adapter.canStop;f.adapter.canStop=()=>false;
 for(const c of original.slice(0,3)){const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);f.obs.set(c.deviceId,{ready:true,result:{resultId:current.queryId,status:'succeeded',name:'fixture'}});}
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='stop').length,0);assert.equal(f.store.snapshot().channels.length,8);
 f.adapter.canStop=canStop;await f.service.tick();await ackStops(f);assert.equal(f.store.snapshot().channels.length,5);
 const stops=f.events.filter(e=>e.kind==='stop').length;for(let i=0;i<5;i++)await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='stop').length,stops);
});
test('lowered concurrency drains only surplus idle sessions within the lower stop budget',async()=>{
 const f=fixture();delayedStops(f);await recoveredEight(f);await ackStops(f);await f.service.configure({concurrency:2},'test');
 await f.service.tick();assert.equal(f.service.admin().counts.executing,2);assert.equal(stopping(f).length,2);await ackStops(f);assert.equal(stopping(f).length,1);await ackStops(f);
 assert.equal(f.store.snapshot().channels.length,2);assert.equal((await f.prepare()).ready,true);
 const starts=f.events.filter(e=>e.kind==='start').length;await f.submit();await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,starts);
 f.advance(300000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,2);
});
test('legacy eight after process restart re-probe and eventually release unproven leftovers',async()=>{
 const f=fixture();const canStop=f.adapter.canStop;f.adapter.canStop=()=>false;await recoveredEight(f);assert.equal(f.store.snapshot().channels.length,8);
 f.adapter.canStop=canStop;f.advance(31000);f.restart();await f.service.tick();assert.equal((await f.prepare()).readyCount,0);
 for(const c of f.store.snapshot().channels.filter(c=>c.requestId))await f.result(c);
 assert.equal((await f.prepare()).readyCount,5);f.advance(121000);await f.service.tick();await ackStops(f);
 assert.equal(f.store.snapshot().channels.length,5);assert.equal((await f.prepare()).readyCount,5);
});
test('a stopped surplus phone is available as a future replacement after a real failure',async()=>{
 const f=fixture();await recoveredEight(f);await ackStops(f);const retired=f.events.filter(e=>e.kind==='stop').map(e=>e.device);
 f.advance(31000);const failed=live(f)[0];f.epochs.set(failed.deviceId,'new-account');f.offline.add(failed.deviceId);await f.service.tick();
 const replacement=f.store.snapshot().channels.find(c=>retired.includes(c.deviceId));assert.ok(replacement);assert.equal(replacement.phase,'starting');
 assert.ok(f.service.reserved(failed.deviceId));await f.readyStart(replacement);await f.result(replacement);assert.equal((await f.prepare()).readyCount,5);
});
