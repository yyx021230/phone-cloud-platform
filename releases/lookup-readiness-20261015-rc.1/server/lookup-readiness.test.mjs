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
 return {get service(){return service;},store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}
test('starts five physical channels; second successful probe immediately admits business while others run',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const p=await f.prepare();assert.equal(p.ready,true);assert.equal(p.readyCount,2);assert.equal(f.events.filter(e=>e.kind==='start').length,5);
 const r=await f.submit();await f.service.tick();const s=f.store.snapshot(),c=s.channels.find(c=>c.requestId===r.lookupId);assert.ok(c.readinessProof);assert.equal(f.service.admin().counts.executing,4);assert.equal(f.events.find(e=>e.id===r.lookupId).options.prepared,true);
 await f.result(c,'张');assert.deepEqual(await f.service.getAsyncResult(r.lookupId,'a'),{ok:true,lookupId:r.lookupId,status:'completed',name:'张'});
 for(const c of f.store.snapshot().channels.filter(c=>!c.readinessProof)){await f.readyStart(c);await f.result(c);}
 assert.equal((await f.prepare()).readyCount,5);assert.equal(f.events.filter(e=>e.kind==='query'&&e.purpose==='readiness_probe').length,5);
});
test('one successful probe is not ready; blank probe cannot pass; human on one phone does not stop another',async()=>{
 const f=fixture();await f.configure();await f.prepare();await f.service.tick();const cs=f.store.snapshot().channels;
 f.obs.set(cs[0].deviceId,{human:true});await f.readyStart(cs[1]);await f.result(cs[1]);await assert.rejects(f.submit(),/lookup_not_ready/);
 await f.readyStart(cs[2]);await f.result(cs[2],'','not_found');assert.equal((await f.prepare()).readyCount,1);
 await f.readyStart(cs[3]);await f.result(cs[3]);assert.equal((await f.prepare()).ready,true);assert.ok(f.store.snapshot().channels.find(c=>c.deviceId===cs[0].deviceId&&c.phase==='human'));
 assert.ok(f.service.admin().counts.executing<=5);
});
test('duplicate start, different start key and concurrent retries do not duplicate probes',async()=>{
 const f=fixture();await f.configure();const results=await Promise.all(Array.from({length:10},(_,i)=>f.prepare('start-key-'+i)));assert.equal(new Set(results.map(r=>r.preparationId)).size,1);await f.service.tick();await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,5);
});
test('two-minute changed business key uses original task; probes never pollute business cache',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const r=await f.submit();await f.service.tick();f.advance(121000);const replay=await f.submit('business-key-2');assert.equal(replay.lookupId,r.lookupId);assert.equal(replay.reused,true);await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
 const probe=f.store.snapshot().requests.find(r=>r.purpose==='readiness_probe');await assert.rejects(f.service.getAsyncResult(probe.lookupId,'a'),/lookup_task_not_found/);
 const samePhone=await f.submit('business-probe-number','13800000000');assert.notEqual(samePhone.lookupId,probe.lookupId);
});
test('unregistered/empty results share one completed shape; processing has no fake empty name',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const r=await f.submit();await f.service.tick();let out=await f.service.getAsyncResult(r.lookupId,'a');assert.equal(out.status,'processing');assert.equal('name' in out,false);assert.equal('code' in out,false);
 const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);await f.result(c,'','not_found');assert.deepEqual(await f.service.getAsyncResult(r.lookupId,'a'),{ok:true,lookupId:r.lookupId,status:'completed',name:''});
});
test('account, Agent, offline and process generation invalidate proof; reads and replay remain available',async()=>{
 const f=fixture();await f.configure();const cs=await f.twoReady();const r=await f.submit();f.epochs.set(cs[0].deviceId,'account-2:agent-1');assert.equal((await f.prepare()).ready,false);await assert.rejects(f.submit('fresh-key-2','13700000000'),/lookup_not_ready/);assert.equal((await f.submit('fresh-key-3')).lookupId,r.lookupId);
 f.offline.add(cs[1].deviceId);assert.equal((await f.prepare()).readyCount,0);f.offline.clear();f.restart();assert.equal((await f.prepare()).readyCount,0);assert.ok(await f.service.getAsyncResult(r.lookupId,'a'));
});
test('ready idle channels stay warm; lease expiry stops new work and does not refresh on polls',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const p=await f.prepare();f.advance(121000);await f.service.tick();assert.equal((await f.prepare()).readyCount,2);assert.equal((await f.prepare()).expiresAt,p.expiresAt);f.advance(1800000);assert.equal((await f.prepare()).status,'expired');await assert.rejects(f.submit(),/lookup_not_ready/);const q=await f.prepare('next-round-key');assert.notEqual(q.preparationId,p.preparationId);
});
test('old client that never prepares retains old response contract',async()=>{const f=fixture();await f.configure();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels[0];await f.readyStart(c);await f.result(c);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'succeeded');});

test('confirmed limit moves same lookup to another proven phone only after stop; repair is an independent probe',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();let c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);const original={...c};
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).status,'rerouting');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
 await f.service.tick();c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.notEqual(c.deviceId,original.deviceId);assert.ok(c.readinessProof);assert.equal((await f.submit('limit-retry-new-key')).lookupId,r.lookupId);
 f.advance(31000);await f.service.tick();const repair=f.store.snapshot().channels.find(c=>c.deviceId===original.deviceId);assert.ok(repair);assert.notEqual(repair.requestId,r.lookupId);assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===repair.requestId).purpose,'readiness_probe');
 await f.result(c,'新');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'新');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,2);
});
test('no ready replacement waits without empty result; unknown execution never transfers',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{unknown:true});await f.service.tick();f.advance(121000);assert.equal((await f.submit('unknown-new-key')).lookupId,r.lookupId);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
 for(const other of f.store.snapshot().channels.filter(x=>x.deviceId!==c.deviceId))f.offline.add(other.deviceId);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();await f.service.tick();const out=await f.service.getAsyncResult(r.lookupId,'a');assert.equal(out.status,'queued');assert.equal('name' in out,false);assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
});
test('received name racing with limit cleanup wins and is never queried again',async()=>{
 const f=fixture();await f.configure();await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();f.obs.set(c.deviceId,{stopped:true,ready:false,result:{resultId:c.queryId,status:'succeeded',name:'原'}});await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'原');await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
});

test('late result from retired generation cannot complete the replacement query',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const old=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(old.deviceId,{ready:true,exhausted:true,result:{resultId:old.queryId,status:'limit_reached'}});await f.service.tick();await f.service.tick();const next=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.notEqual(next.queryId,old.queryId);
 f.obs.set(next.deviceId,{busy:true,result:{resultId:old.queryId,status:'succeeded',name:'stale'}});await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'processing');await f.result(next,'fresh');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'fresh');
});
test('cancel while confirmed limit is stopping never requeues the original number',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});await f.service.tick();await f.service.cancel(r.lookupId,'test');await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'failed');assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
});
