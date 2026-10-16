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
 return {adapter,get service(){return service;},store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

const stop=(f,p,key='round-stop-key-1')=>f.service.stopRound({clientId:'a',preparationId:p.preparationId,key});
const drain=async f=>{await f.service.tick();await f.service.tick();await f.service.tick();};
test('round stop cancels queue and probes, waits for stop ACK, never dispatches more',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const p=await f.prepare();
 const ids=[];for(let i=0;i<7;i++)ids.push((await f.submit('stop-business-'+i,'1390000000'+i)).lookupId);await f.service.tick();
 const before=f.events.filter(e=>e.kind==='query').length;const res=await stop(f,p);assert.equal(res.status,'stopping');assert.equal(res.stopped,false);
 const queued=f.store.snapshot().requests.filter(r=>ids.includes(r.lookupId)&&r.status==='cancelled');assert.equal(queued.length,5);for(const r of queued)assert.equal(r.code,'lookup_round_stopped');
 await assert.rejects(f.prepare('new-round-while-stopping'),/lookup_round_stopping/);await assert.rejects(f.submit('blocked-new-number','13700000000'),/lookup_not_ready/);
 await drain(f);assert.equal((await stop(f,p)).status,'stopped');assert.equal(f.store.snapshot().channels.length,0);assert.equal(f.events.filter(e=>e.kind==='query').length,before);
 for(const id of ids){const out=await f.service.getAsyncResult(id,'a');assert.equal(out.status,'failed');assert.equal(out.code,'lookup_round_stopped');}
 await f.service.tick();assert.equal(f.store.snapshot().channels.length,0);assert.equal((await f.prepare()).status,'stopped');
});
test('received results before or racing with stop remain retrievable',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const done=await f.submit();await f.service.tick();let c=f.store.snapshot().channels.find(c=>c.requestId===done.lookupId);await f.result(c,'kept');
 const race=await f.submit('race-stop-business','13700000000');await f.service.tick();c=f.store.snapshot().channels.find(c=>c.requestId===race.lookupId);await stop(f,p);f.obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId,status:'succeeded',name:'late'}});await drain(f);
 assert.equal((await f.service.getAsyncResult(done.lookupId,'a')).name,'kept');assert.equal((await f.service.getAsyncResult(race.lookupId,'a')).name,'late');assert.equal((await stop(f,p)).stopped,true);
});
test('stopping is not stopped until real acknowledgment; offline does not block other caller',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();f.offline.add('d51');
 await f.store.transact(s=>{s.grants.push({clientId:'b',enabled:true,consentReference:'second-client'});s.channels.push({deviceId:'other-phone',clientId:'b',generation:'other-gen',sessionId:'other-session',requestId:'other-query',phase:'querying'});s.requests.push({lookupId:'other-query',clientId:'b',status:'running',queryId:'q-other',attempts:[],name:''});});f.obs.set('other-phone',{busy:true});
 await stop(f,p);await drain(f);assert.equal((await stop(f,p)).status,'stopping');assert.equal(f.store.snapshot().channels.some(c=>c.deviceId==='other-phone'),true);assert.equal(f.events.some(e=>e.kind==='stop'&&e.device==='other-phone'),false);await assert.rejects(f.prepare('blocked-offline-round'),/lookup_round_stopping/);
 f.offline.clear();await drain(f);assert.equal((await stop(f,p)).stopped,true);assert.equal(f.store.snapshot().channels.length,1);
});
test('same stop key after restart is stable and delayed old stop cannot stop a new round',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();await stop(f,p);f.restart();await drain(f);assert.equal((await stop(f,p)).stopped,true);
 const next=await f.prepare('fresh-after-stop');assert.notEqual(next.preparationId,p.preparationId);await f.service.tick();const started=f.events.filter(e=>e.kind==='start').length;
 assert.equal((await stop(f,p)).stopped,true);assert.equal((await stop(f,p,'old-round-new-key')).stopped,true);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,started);assert.equal(f.store.snapshot().channels.length,2);
 await assert.rejects(stop(f,next),/idempotency_conflict/);assert.equal((await stop(f,next,'new-round-stop-key')).status,'stopping');
});
test('stop before probes start completes immediately and old prepare polling never reactivates',async()=>{
 const f=fixture();await f.configure();const p=await f.prepare();assert.equal((await stop(f,p)).stopped,true);for(let i=0;i<4;i++){assert.equal((await f.prepare()).status,'stopped');await f.service.tick();}assert.equal(f.events.length,0);
 const fresh=await f.prepare('new-prepare-key');assert.notEqual(fresh.preparationId,p.preparationId);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,5);
});
test('bad or cross-client preparation and stop keys never mutate an active round',async()=>{
 const f=fixture();await f.configure();const p=await f.prepare();const before=f.store.snapshot();await assert.rejects(stop(f,{preparationId:'other-id'}),/lookup_preparation_not_found/);await assert.rejects(stop(f,p,'bad'),/invalid_idempotency_key/);await assert.rejects(f.service.stopRound({clientId:'b',preparationId:p.preparationId,key:'valid-stop-key'}),/managed_lookup_not_authorized/);assert.deepEqual(f.store.snapshot(),before);
});
test('unknown execution remains reserved and restart cannot bypass stop',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{unknown:true});};await stop(f,p);await drain(f);assert.equal((await stop(f,p)).stopped,false);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'processing');f.restart();await assert.rejects(f.prepare('new-after-unknown'),/lookup_round_stopping/);
 for(const c of f.store.snapshot().channels)f.obs.set(c.deviceId,{stopped:true,ready:false});await drain(f);assert.equal((await stop(f,p)).stopped,true);
});
test('stop cancels confirmed-limit reroute and recovery, never launches another query',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();await stop(f,p);await drain(f);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).code,'lookup_round_stopped');assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
});
test('manual recovery and human resumption cannot bypass a round stop',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.obs.set(c.deviceId,{recovery:true});await f.service.tick();await stop(f,p);await assert.rejects(f.service.retry(r.lookupId,'test'),/managed_recovery_not_ready/);assert.equal(await f.service.beforeResume(c.sessionId),false);
});
test('global pool disabled still permits stopping own existing round',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();await f.service.configure({enabled:false},'test');assert.equal((await stop(f,p)).status,'stopping');await drain(f);assert.equal((await stop(f,p)).stopped,true);
});
test('concurrent stop retries and prepare polls cannot reopen the stopped generation',async()=>{
 const f=fixture();await f.configure();const p=await f.prepare();await Promise.all([stop(f,p),f.prepare(),stop(f,p)]);await f.service.tick();assert.equal(f.events.length,0);assert.equal((await f.prepare()).status,'stopped');assert.equal(f.store.snapshot().roundStops.length,1);
});
test('a missing execution binding is not falsely acknowledged as safely stopped',async()=>{
 const f=fixture();await f.configure();const p=await f.prepare();await f.store.transact(s=>s.requests.push({lookupId:'lost-binding',clientId:'a',status:'running',attempts:[],name:''}));assert.equal((await stop(f,p)).stopped,false);await drain(f);assert.equal((await stop(f,p)).stopped,false);
});
test('legacy submit for a prepared stopped caller cannot bypass the stop gate',async()=>{
 const f=fixture();await f.configure();const p=await f.prepare();await stop(f,p);await assert.rejects(f.service.submit({clientId:'a',key:'legacy-new-query',phoneNumber:'13900000000'}),/lookup_round_stopped/);
});
