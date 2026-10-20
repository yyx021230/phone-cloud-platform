import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},quarantineRoundStop:async c=>{events.push({kind:'fence',device:c.deviceId});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
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
const quarantine=async f=>{await f.service.tick();f.advance(30000);await drain(f);};

test('round ends after offline grace while its phone stays reserved; healthy phones start the next round',async()=>{
 const f=fixture();await f.configure([51,52,54,55]);await f.twoReady();const p=await f.prepare();
 const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.offline.add(c.deviceId);f.obs.set(c.deviceId,{unknown:true});await stop(f,p);await f.service.tick();
 assert.equal((await stop(f,p)).stopped,false);f.advance(29999);await f.service.tick();assert.equal((await stop(f,p)).stopped,false);
 f.advance(1);await drain(f);assert.equal((await stop(f,p)).stopped,true);
 assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');assert.equal(f.service.admin().counts.executing,0);
 assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).code,'lookup_round_stopped');
 const next=await f.prepare('new-round-after-offline');assert.notEqual(next.preparationId,p.preparationId);
 await f.service.tick();assert.ok(f.store.snapshot().channels.some(x=>x.deviceId!==c.deviceId&&x.preparationId===next.preparationId));
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
});
test('temporary disconnect resets the grace and never detaches or clears a phone lock',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();
 f.offline.add('d51');await stop(f,p);await f.service.tick();f.advance(20000);
 f.adapter.stop=async()=>{};f.offline.clear();await f.service.tick();f.offline.add('d51');await f.service.tick();f.advance(20000);await f.service.tick();
 assert.equal((await stop(f,p)).stopped,false);assert.equal(f.events.filter(e=>e.kind==='fence').length,0);assert.ok(f.service.reserved('d51'));
});
test('offline idle and puzzle sessions cannot block idle-expiry stop forever',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();
 f.offline.add('d51');f.offline.add('d52');f.obs.set('d52',{human:true});f.advance(900001);await quarantine(f);
 assert.equal((await f.prepare()).status,'stopped');assert.equal(f.store.snapshot().channels.length,2);
 assert.ok(f.store.snapshot().channels.every(c=>c.phase==='quarantined'));assert.equal(f.events.filter(e=>e.kind==='fence').length,2);
 f.restart();assert.equal((await stop(f,p)).stopped,true);await f.prepare('new-round-after-restart');
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='fence').length,2);
});
test('next-round stop never rebinds quarantined channels from the old round',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const old=await f.prepare();f.offline.add('d51');await stop(f,old);await quarantine(f);
 const next=await f.prepare('next-round-no-rebind');await f.service.tick();await stop(f,next,'next-round-stop-key');await drain(f);
 assert.equal((await stop(f,next,'next-round-stop-key')).stopped,true);assert.equal(f.service.reserved('d51').roundStopPreparationId,old.preparationId);
 await stop(f,old,'late-old-stop-key');assert.equal(f.service.reserved('d51').roundStopPreparationId,old.preparationId);
});
test('reconnected quarantined phone waits for real cleanup ACK before reuse',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();f.offline.add('d51');await stop(f,p);await quarantine(f);
 const q=f.service.reserved('d51');f.adapter.stop=async c=>{f.events.push({kind:'cleanup',device:c.deviceId});f.obs.set(c.deviceId,{unknown:true});};
 f.offline.clear();await f.prepare('next-with-reconnection');await f.service.tick();assert.equal(f.service.reserved('d51').phase,'stopping');
 assert.equal(f.events.filter(e=>e.kind==='start'&&e.device==='d51').length,1);assert.equal(await f.service.beforeResume(q.sessionId),false);
 f.restart();await f.service.tick();assert.ok(f.service.reserved('d51'));
 f.obs.set('d51',{stopped:true});await f.service.tick();assert.equal(f.service.reserved('d51'),undefined);
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start'&&e.device==='d51').length,2);
});
test('failed durable fencing remains fail-closed and does not block another phone cleanup',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();f.offline.add('d51');
 f.adapter.quarantineRoundStop=async()=>{throw Error('simulated fence write failure');};await stop(f,p);await f.service.tick();f.advance(30000);
 await assert.rejects(f.service.tick(),/managed_lookup_device_errors/);
 assert.equal((await stop(f,p)).stopped,false);assert.ok(f.service.reserved('d51'));assert.equal(f.service.reserved('d52'),undefined);
 await assert.rejects(f.prepare('new-after-failed-fence'),/lookup_round_stopping/);
});
test('received successful result is retained while an offline completed channel is quarantined',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);await stop(f,p);
 f.offline.add(c.deviceId);f.obs.set(c.deviceId,{unknown:true,result:{resultId:c.queryId,status:'succeeded',name:'kept'}});
 await f.service.tick();await quarantine(f);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'kept');assert.equal((await stop(f,p)).stopped,true);
 assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');await f.service.tick();assert.equal(f.service.reserved(c.deviceId).phase,'quarantined');
});
test('online unknown execution still requires stop ACK and is never detached by a timer',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();f.adapter.stop=async c=>{f.obs.set(c.deviceId,{unknown:true});};
 await stop(f,p);await quarantine(f);f.advance(900000);await drain(f);assert.equal((await stop(f,p)).stopped,false);
 assert.equal(f.events.filter(e=>e.kind==='fence').length,0);
});
test('a second disconnect cancels pending cleanup without consuming a new-round execution slot forever',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();f.offline.add('d51');await stop(f,p);await quarantine(f);
 f.adapter.stop=async c=>{f.obs.set(c.deviceId,{unknown:true});};f.offline.clear();await f.service.tick();assert.equal(f.service.reserved('d51').phase,'stopping');
 f.offline.add('d51');await quarantine(f);assert.equal(f.service.reserved('d51').phase,'quarantined');
 assert.equal(f.service.admin().counts.executing,0);assert.equal((await stop(f,p)).stopped,true);
 assert.equal(f.events.filter(e=>e.kind==='fence').length,2);
});
test('settled offline quarantine does not keep writing transactions or rebinding across polls',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();f.offline.add('d51');await stop(f,p);await quarantine(f);
 let writes=0;const transact=f.store.transact;f.store.transact=(fn)=>{writes++;return transact(fn);};
 for(let i=0;i<20;i++)await f.service.tick();assert.equal(writes,0);assert.equal(f.events.filter(e=>e.kind==='fence').length,1);
});
