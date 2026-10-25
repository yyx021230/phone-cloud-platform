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
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

import {PREPARATION_KEY_TTL_MS} from './lookup-readiness.mjs';
const blocked={jobId:'login-evidence',account:'138******01',reason:'account_login_required'};
async function stop(f){const p=f.store.snapshot().preparations[0];await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'stop-'+p.preparationId});for(let i=0;i<6;i++)await f.service.tick();assert.equal(f.store.snapshot().channels.length,0);}
test('1000 persisted legacy aliases cannot block a genuinely new round; old keys cannot reopen it',async()=>{
 const f=fixture();await f.configure();await f.prepare();await stop(f);const old=f.store.snapshot().preparations[0];
 await f.store.transact(s=>{s.preparationKeys=Array.from({length:1000},(_,i)=>({clientId:'a',key:'legacy-key-'+i,preparationId:old.preparationId}));});
 const p=await f.prepare('fresh-round-key');assert.notEqual(p.preparationId,old.preparationId);assert.equal(p.ready,false);
 await assert.rejects(f.prepare('legacy-key-0'),/lookup_preparation_expired/);assert.ok(f.store.snapshot().preparationKeys.every(k=>Number.isFinite(k.expiresAt)));
});
test('new-key prepare storm preserves exclusions and proofs and keeps business flowing through healthy phones',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const bad=f.store.snapshot().channels[0];
 f.obs.set(bad.deviceId,{stopped:true,accountOffline:blocked});await f.service.tick();await f.service.tick();
 for(const c of f.store.snapshot().channels){await f.readyStart(c);await f.result(c);}
 const original=f.store.snapshot(),epoch=original.preparations[0].loginEpoch,id=original.preparations[0].preparationId;
 const before=f.events.filter(e=>e.device===bad.deviceId&&e.kind==='start').length;
 for(let i=0;i<45;i++){await f.prepare('poll-fresh-key-'+i);await f.service.tick();}
 assert.equal(f.store.snapshot().preparations[0].loginEpoch,epoch);assert.equal(f.store.snapshot().preparations[0].preparationId,id);
 assert.equal(f.events.filter(e=>e.device===bad.deviceId&&e.kind==='start').length,before);
 const jobs=await Promise.all(Array.from({length:20},(_,i)=>f.submit('business-queue-'+i,'1390000'+String(i).padStart(4,'0'))));
 for(let n=0;n<30;n++){await f.service.tick();for(const c of f.store.snapshot().channels){const q=f.store.snapshot().requests.find(r=>r.lookupId===c.requestId);if(q?.purpose!=='readiness_probe'&&q?.status==='running')await f.result(c,'测试');}}
 for(const j of jobs)assert.equal((await f.service.getAsyncResult(j.lookupId,'a')).status,'completed');
 assert.ok(f.events.filter(e=>e.kind==='query'&&jobs.some(j=>j.lookupId===e.id)).every(e=>e.device!==bad.deviceId));
 await stop(f);await f.prepare('after-stop-new-round');await f.service.tick();assert.equal(f.events.filter(e=>e.device===bad.deviceId&&e.kind==='start').length,before+1);
});
test('legacy active login epoch survives upgrade and fresh aliases',async()=>{
 const f=fixture();await f.configure([51,52]);const p=await f.prepare();await f.store.transact(s=>{delete s.preparations[0].loginEpoch;s.devices[0].accountOffline={...blocked,blockedRounds:[{clientId:'a',preparationId:p.preparationId,epoch:p.preparationId}]};});
 await f.prepare('upgrade-new-key');await f.service.tick();assert.equal(f.store.snapshot().preparations[0].loginEpoch,undefined);assert.ok(!f.events.some(e=>e.device==='d51'));
});
test('prepare aliases expire after a fixed 24h, including legacy grace, and never slide on replay',async()=>{
 const f=fixture();await f.configure();await f.prepare();await stop(f);
 const before=f.store.snapshot().preparationKeys[0].expiresAt;f.advance(3600000);await f.prepare();assert.equal(f.store.snapshot().preparationKeys[0].expiresAt,before);f.restart();await f.prepare();assert.equal(f.store.snapshot().preparationKeys[0].expiresAt,before);
 f.advance(PREPARATION_KEY_TTL_MS);const next=await f.prepare();assert.equal(next.status,'preparing');assert.equal(f.store.snapshot().preparationKeys.length,1);assert.ok(f.store.snapshot().preparationKeys[0].expiresAt>before);
});
test('new-key rate budget recovers after a minute; same-key reads and other clients are independent',async()=>{
 const f=fixture();await f.configure();for(let i=0;i<60;i++)await f.prepare('rate-key-'+i);
 const snapshot=f.store.snapshot();await assert.rejects(f.prepare('rate-key-60'),e=>e.statusCode===429&&e.message==='lookup_preparation_rate_limit');assert.equal((await f.prepare('rate-key-0')).preparationId,snapshot.preparations[0].preparationId);
 await f.store.transact(s=>s.grants.push({clientId:'b',enabled:true}));assert.equal((await f.service.prepare({clientId:'b',key:'rate-key-60'})).status,'preparing');
 f.advance(60000);assert.equal((await f.prepare('rate-key-60')).preparationId,snapshot.preparations[0].preparationId);
});

test('fresh polling key cannot release legacy isolation; only a new round reclassifies proven page failures',async()=>{
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.store.transact(s=>{for(const d of s.devices){d.lookupUnavailable=true;d.prepareFailureCount=3;d.fixtureCooldownUntil=123456;}});
 f.adapter.legacyPageIsolation=d=>d.deviceId==='d51'?{domain:'page',code:'alipay_page_element_changed',jobIds:['a','b','c']}:null;
 await f.prepare('same-round-isolation-poll');assert.ok(f.store.snapshot().devices.every(d=>d.lookupUnavailable));await stop(f);await f.prepare('new-round-isolation-check');const ds=f.store.snapshot().devices;assert.equal(ds[0].lookupUnavailable,false);assert.equal(ds[1].lookupUnavailable,true);assert.equal(ds[0].fixtureCooldownUntil,123456);
});
