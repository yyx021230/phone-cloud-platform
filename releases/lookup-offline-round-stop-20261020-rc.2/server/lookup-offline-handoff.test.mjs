import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={isOffline:c=>offline.has(c.deviceId),clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},quarantineRoundStop:async c=>{events.push({kind:'fence',device:c.deviceId});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {adapter,get service(){return service;},store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

const drop=async(f,c)=>{f.offline.add(c.deviceId);f.obs.set(c.deviceId,{unknown:true});await f.service.tick();};
const advanceOffline=async f=>{f.advance(30000);await f.service.tick();};
const business=async f=>{await f.configure([51,52]);await f.twoReady();const req=await f.submit();await f.service.tick();return {req,c:f.store.snapshot().channels.find(c=>c.requestId===req.lookupId)};};
test('active offline query retains lookup ID and moves to a healthy ready phone after fencing',async()=>{
 const f=fixture();const {req,c}=await business(f);await drop(f,c);f.advance(29999);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);
 f.advance(1);await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===req.lookupId);
 assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');assert.equal(f.events.filter(e=>e.kind==='fence').length,1);
 assert.equal((await f.submit('alias-after-offline')).lookupId,req.lookupId);await f.result(next,'续');assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).name,'续');
 assert.equal((f.store.snapshot().roundStops||[]).length,0);
});
test('short offline observation resets on reconnect, without replaying the business',async()=>{
 const f=fixture();const {req,c}=await business(f);await drop(f,c);f.advance(20000);f.offline.clear();f.obs.set(c.deviceId,{busy:true});await f.service.tick();await drop(f,c);f.advance(20000);await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='fence').length,0);assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);
});
test('handoff cleanup survives restart; late old results never complete the reassigned query',async()=>{
 const f=fixture();const {req,c}=await business(f);await drop(f,c);await advanceOffline(f);f.restart();
 f.obs.set(c.deviceId,{unknown:true,result:{resultId:c.queryId,status:'succeeded',name:'旧'}});await f.service.tick();assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'processing');
 const next=f.store.snapshot().channels.find(x=>x.requestId===req.lookupId);await f.result(next,'新');assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).name,'新');
 f.adapter.stop=async x=>{f.events.push({kind:'cleanup',device:x.deviceId});f.obs.set(x.deviceId,{unknown:true});};f.offline.clear();await f.service.tick();
 assert.equal(f.service.reserved(c.deviceId).phase,'stopping');assert.equal(await f.service.beforeResume(c.sessionId),false);
 assert.equal(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length,1);f.obs.set(c.deviceId,{stopped:true});await f.service.tick();assert.equal(f.service.reserved(c.deviceId),undefined);
});
test('manual stop wins over offline handoff, and its cleanup cannot hold the next round',async()=>{
 const f=fixture();const {req,c}=await business(f);await drop(f,c);const p=await f.prepare();await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'manual-stop-key'});await f.service.tick();await advanceOffline(f);await f.service.tick();
 assert.equal((await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'manual-stop-key'})).stopped,true);
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).code,'lookup_round_stopped');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);
 await f.prepare('next-after-stop-key');
});
test('business waiting on all offline devices does not trigger the fifteen minute idle stop',async()=>{
 const f=fixture();const {req,c}=await business(f);for(const x of f.store.snapshot().channels)await drop(f,x);await advanceOffline(f);f.advance(900001);await f.service.tick();
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'queued');assert.equal((f.store.snapshot().roundStops||[]).length,0);assert.equal(f.store.snapshot().preparations[0].idleSince,null);
});
test('fifteen minutes after handed-off result the round ends despite old offline reservation',async()=>{
 const f=fixture();const {req,c}=await business(f);await drop(f,c);await advanceOffline(f);const next=f.store.snapshot().channels.find(x=>x.requestId===req.lookupId);await f.result(next);await f.service.tick();
 f.advance(900001);await f.service.tick();await f.service.tick();await f.service.tick();assert.equal((await f.prepare()).status,'stopped');assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'completed');await f.prepare('after-natural-close');
});
test('fence persistence failure never reassigns the original business',async()=>{
 const f=fixture();const {req,c}=await business(f);f.adapter.quarantineRoundStop=async()=>{throw Error('fence failure');};await drop(f,c);f.advance(30000);await assert.rejects(f.service.tick(),/managed_lookup_device_errors/);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);assert.equal(f.service.reserved(c.deviceId).requestId,req.lookupId);
});
test('already received result wins over a disconnect and is never replayed',async()=>{
 const f=fixture();const {req,c}=await business(f);f.offline.add(c.deviceId);f.obs.set(c.deviceId,{unknown:true,result:{resultId:c.queryId,status:'succeeded',name:'已得'}});await f.service.tick();await f.service.tick();await advanceOffline(f);
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).name,'已得');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');
});

test('handoff preserves the original total deadline rather than expiring a started query at its initial queue deadline',async()=>{
 const f=fixture();const {req,c}=await business(f);f.advance(1800001);await drop(f,c);await advanceOffline(f);
 const r=f.store.snapshot().requests.find(r=>r.lookupId===req.lookupId);assert.equal(r.status,'queued');assert.equal(r.deadline,r.executionDeadline);
 assert.equal((f.store.snapshot().roundStops||[]).length,0);assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'queued');
});
