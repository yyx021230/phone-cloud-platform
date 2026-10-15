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
async function fail(f,id,kind='start'){
 const c=f.store.snapshot().channels.find(c=>c.deviceId===id);assert.ok(c);
 if(kind==='read'){await f.readyStart(c);f.obs.set(id,{recovery:true,ready:true});}
 else f.obs.set(id,{startFailed:true,stopped:true,ready:false});
 await f.service.tick();await f.service.tick();
}
async function next(f){f.advance(121000);await f.service.tick();}
async function trip(f,id='d51'){
 for(let n=0;n<3;n++){await fail(f,id);if(n<2)await next(f);}
}
test('three failed preparations quarantine one phone while two healthy phones keep returning results',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();
 for(const id of ['d52','d54']){const c=f.store.snapshot().channels.find(c=>c.deviceId===id);await f.readyStart(c);await f.result(c);}
 await trip(f);assert.equal(f.service.admin().devices.find(d=>d.deviceId==='d51').health.reason,'lookup_device_unavailable');
 const before=f.events.filter(e=>e.kind==='start'&&e.device==='d51').length;f.advance(121000);await f.prepare('poll-after-quarantine');await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start'&&e.device==='d51').length,before);
 const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.notEqual(c.deviceId,'d51');await f.result(c,'名');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'名');
});
test('query-stage probe failures count once and startup success alone does not erase the streak',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();
 for(let n=1;n<=3;n++){await fail(f,'d51','read');assert.equal(f.store.snapshot().devices[0].prepareFailureCount,n);await f.service.tick();assert.equal(f.store.snapshot().devices[0].prepareFailureCount,n);if(n<3)await next(f);}
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);
});
test('successful named probe resets the failure streak; human pause does not count',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();await fail(f,'d51');await next(f);
 let c=f.store.snapshot().channels[0];await f.readyStart(c);f.obs.set('d51',{human:true});await f.service.tick();assert.equal(f.store.snapshot().devices[0].prepareFailureCount,1);
 await f.result(c);assert.equal(f.store.snapshot().devices[0].prepareFailureCount,0);
});
test('quarantine persists through restart and ordinary settings changes, including disable and enable',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();await trip(f);f.restart();await f.configure([51]);
 await f.service.configure({devices:[{deviceId:'d51',deviceNumber:51,enabled:false}]},'test');await f.configure([51]);f.advance(121000);await f.service.tick();
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);assert.equal(f.events.filter(e=>e.kind==='start').length,3);
});
test('manual reprobe uses revision guard and refuses offline or reserved devices',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();await trip(f);
 const reset={resetUnavailableDeviceIds:['d51'],expectedConfigRevision:f.store.snapshot().configRevision};
 await assert.rejects(f.service.configure({...reset,expectedConfigRevision:0},'admin'),/pool_config_changed/);
 f.offline.add('d51');await assert.rejects(f.service.configure(reset,'admin'),/lookup_device_reset_not_ready/);f.offline.clear();
 await f.store.transact(s=>s.channels.push({deviceId:'d51',phase:'unknown'}));await assert.rejects(f.service.configure(reset,'admin'),/lookup_device_reset_not_ready/);await f.store.transact(s=>s.channels=[]);
 await f.service.configure(reset,'admin');assert.equal(f.store.snapshot().devices[0].lookupUnavailable,false);assert.equal((await f.prepare()).readyCount,0);
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,4);assert.equal(f.events.filter(e=>e.kind==='query'&&e.purpose!=='readiness_probe').length,0);
});
test('reset rejects unknown and duplicated device IDs atomically',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();await trip(f);const rev=f.store.snapshot().configRevision;
 await assert.rejects(f.service.configure({resetUnavailableDeviceIds:['d51','d51'],expectedConfigRevision:rev},'admin'),/invalid_unavailable_reset/);
 await assert.rejects(f.service.configure({resetUnavailableDeviceIds:['d51','missing'],expectedConfigRevision:rev},'admin'),/lookup_device_not_quarantined/);
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);assert.equal(f.store.snapshot().configRevision,rev);
});
