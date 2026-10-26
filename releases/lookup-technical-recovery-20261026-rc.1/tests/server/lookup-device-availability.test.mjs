import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={preparationFailure:()=>({domain:'device',code:'fixture_transport_failed'}),clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
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
 // Round admission stays open; stale phones still require fresh proofs.
 assert.equal((await f.prepare()).ready,true);assert.equal((await f.prepare()).readyCount,0);
 for(let i=0;i<3;i++)await f.service.tick();
 for(const id of ['d52','d54']){const c=f.store.snapshot().channels.find(c=>c.deviceId===id);assert.ok(c);await f.readyStart(c);await f.result(c);}
 assert.equal((await f.prepare()).ready,true);assert.equal(f.service.admin().devices.find(d=>d.deviceId==='d51').health.reason,'lookup_device_unavailable');
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

test('two soft startup failures retain backoff through configure and restart; a new round does not bypass the remaining backoff',async()=>{
 const f=fixture();f.adapter.preparationFailure=()=>({domain:'page',code:'alipay_account_identity_unverified'});
 await f.configure([51]);await f.prepare();await f.service.tick();await fail(f,'d51');await next(f);await fail(f,'d51');
 assert.equal(f.service.admin().devices[0].health.reason,'page_preparation_backoff');
 await f.configure([51]);f.restart();await next(f);await f.prepare('another-key-same-round');await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='start').length,2);assert.equal(f.store.snapshot().devices[0].prepareFailureCount,0);
 await f.service.stopRound({clientId:'a',key:'stop-soft-round',preparationId:f.store.snapshot().preparations[0].preparationId});await f.service.tick();await f.service.tick();
 await f.prepare('fresh-new-round');await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,2);f.advance(180000);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,3);
});

// Real incidents, sanitized: Oct-23 RPC/worker circuits still isolated Oct-26.
async function oldCircuits(f,numbers=[51,52]){
 await f.configure(numbers);await f.prepare();
 await f.store.transact(s=>{for(const d of s.devices){d.lookupUnavailable=true;d.prepareFailureCount=3;d.lookupUnavailableAt=Date.now()-86400000;d.lastPreparationFailure={domain:'device',code:'alipay_lookup_failed',jobId:'old-'+d.deviceId,at:d.lookupUnavailableAt};}});
}
test('old transport circuits receive one probe; only its named result restores readiness and business',async()=>{
 const f=fixture();await oldCircuits(f);await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='start').length,1);
 let c=f.store.snapshot().channels[0];assert.ok(f.store.snapshot().requests.find(r=>r.lookupId===c.requestId).deviceReprobe);
 await f.readyStart(c);assert.equal(f.service.admin().devices[0].health.reason,'lookup_device_unavailable');
 await assert.rejects(f.submit(),/lookup_not_ready/);await f.result(c);
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,false);assert.equal((await f.prepare()).readyCount,1);
 f.advance(60000);await f.service.tick();c=f.store.snapshot().channels.find(c=>c.deviceId==='d52');await f.readyStart(c);await f.result(c);
 assert.equal((await f.prepare()).ready,true);const r=await f.submit();await f.service.tick();c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);await f.result(c,'完成');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'完成');
});
test('reprobe failure retains isolation and waits 15 minutes, including page failures, restart and configure',async()=>{
 const f=fixture();await oldCircuits(f,[51]);await f.service.tick();f.adapter.preparationFailure=()=>({domain:'page',code:'alipay_page_element_changed'});await fail(f,'d51');
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);await f.configure([51]);f.restart();f.advance(899999);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,1);
 // Keep this simulated round active; real ongoing business renews its idle clock.
 await f.store.transact(s=>{s.preparations[0].idleSince=Date.now()+900000;s.preparations[0].expiresAt=Date.now()+1800000;});
 f.advance(1);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,2);
});
test('offline, busy, cooling, login excluded, disabled and unknown circuits cannot be auto-cleared',async()=>{
 for(const reason of ['offline','screen_control_active','accounts_cooling','login','disabled','unknown']){
  const f=fixture();await oldCircuits(f,[51]);
  if(['offline','screen_control_active','accounts_cooling'].includes(reason))f.adapter.health=()=>({ready:false,reason});
  if(reason==='login')await f.store.transact(s=>{const p=s.preparations[0];s.devices[0].accountOffline={clientId:'a',preparationId:p.preparationId,loginEpoch:p.loginEpoch,blockedRounds:[{clientId:'a',preparationId:p.preparationId,epoch:p.loginEpoch}]};});
  if(reason==='disabled')await f.store.transact(s=>s.devices[0].enabled=false);
  if(reason==='unknown')await f.store.transact(s=>{delete s.devices[0].lastPreparationFailure;});
  await f.service.tick();assert.equal(f.events.length,0,reason);assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);
 }
});
test('stop during half-open probe retains isolation and late result cannot reopen stopped round',async()=>{
 const f=fixture();await oldCircuits(f,[51]);await f.service.tick();let c=f.store.snapshot().channels[0];await f.readyStart(c);
 await f.service.stopRound({clientId:'a',key:'stop-half-open-round',preparationId:f.store.snapshot().preparations[0].preparationId});await f.result(c);
 assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);assert.equal((await f.prepare()).ready,false);
});
test('blank probe and stale query ID never release a transport circuit',async()=>{
 const f=fixture();await oldCircuits(f,[51]);await f.service.tick();let c=f.store.snapshot().channels[0];await f.readyStart(c);
 f.obs.set(c.deviceId,{ready:true,result:{resultId:'old-generation-query',status:'succeeded',name:'旧'}});await f.service.tick();assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);
 await f.result(c,'','not_found');assert.equal(f.store.snapshot().devices[0].lookupUnavailable,true);assert.equal((await f.prepare()).readyCount,0);
});
test('foreground state failure backs off, remains outside result AI, then permits a fresh probe',async()=>{
 const f=fixture();f.adapter.preparationFailure=()=>({domain:'state',code:'alipay_lookup_result_unconfirmed'});await f.configure([51]);await f.prepare();await f.service.tick();
 await fail(f,'d51');await next(f);await fail(f,'d51');assert.equal(f.service.admin().devices[0].health.reason,'page_preparation_backoff');assert.equal(f.store.snapshot().devices[0].preparationIssue.domain,'state');
 f.advance(300000);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start').length,3);const c=f.store.snapshot().channels[0];await f.readyStart(c);await f.result(c);assert.equal((await f.prepare()).readyCount,1);
});
test('normal spare capacity wins before a half-open circuit; physical occupancy stays bounded',async()=>{
 const f=fixture();await oldCircuits(f,[51,52,54]);await f.store.transact(s=>{s.config.concurrency=2;s.devices[2].lookupUnavailable=false;delete s.devices[2].lastPreparationFailure;});
 await Promise.all([f.service.tick(),f.service.tick()]);assert.equal(f.events[0].device,'d54');assert.equal(f.store.snapshot().channels.length,2);assert.equal(f.store.snapshot().requests.filter(r=>r.deviceReprobe).length,1);
});
