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
 return {adapter,now:()=>clock,get service(){return service;},store,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

const drain=async f=>{await f.service.tick();await f.service.tick();await f.service.tick();};
test('idle round expires at exactly fifteen minutes despite polling and new prepare keys',async()=>{
 const f=fixture();await f.configure([51,52]);const p=await f.prepare();
 f.advance(899999);assert.equal((await f.prepare()).expiresAt,p.expiresAt);assert.equal((await f.prepare('different-prepare-key')).preparationId,p.preparationId);
 f.advance(1);assert.equal((await f.prepare()).status,'expired');await assert.rejects(f.prepare('not-a-renewal'),/lookup_round_stopping/);
 await drain(f);assert.equal((await f.prepare()).status,'stopped');assert.equal(f.store.snapshot().preparations[0].autoStopReason,'idle_timeout');assert.equal(f.events.length,0);
 const next=await f.prepare('explicit-next-round');assert.notEqual(next.preparationId,p.preparationId);
});
test('business pending for over thirty minutes retains the round; final completion starts a full fifteen minutes',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.advance(31*60000);await f.service.tick();
 assert.equal((await f.prepare()).preparationId,p.preparationId);assert.equal((await f.prepare()).expiresAt,null);assert.notEqual((await f.prepare()).status,'expired');
 assert.equal((await f.submit('timeout-new-key')).lookupId,r.lookupId);assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
 await f.result(c,'kept');const expiry=(await f.prepare()).expiresAt;assert.ok(expiry);f.advance(899999);await f.service.tick();assert.equal((await f.prepare()).expiresAt,expiry);assert.notEqual((await f.prepare()).status,'stopped');
 f.advance(1);await drain(f);assert.equal((await f.prepare()).status,'stopped');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'kept');
});
test('queued, manual wait, recovery and unknown business are not idle; probes alone are',async()=>{
 for(const status of ['queued','running','waiting_human','needs_recovery','unknown','rerouting','cancelling']){
  const f=fixture();await f.configure([51,52]);await f.prepare();await f.store.transact(s=>s.requests.push({lookupId:'held-business',clientId:'a',status,createdAt:new Date().toISOString(),deadline:Date.now()+3900000,executionDeadline:Date.now()+3900000,attempts:[]}));
  f.advance(901000);await f.service.tick();assert.equal(f.store.snapshot().preparations[0].stopRequestedAt,undefined,status);assert.equal((await f.prepare()).expiresAt,null,status);
 }
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.service.tick();for(const c of f.store.snapshot().channels)f.obs.set(c.deviceId,{human:true});
 await f.service.tick();f.advance(900000);await drain(f);assert.equal((await f.prepare()).status,'stopped');assert.equal(f.store.snapshot().channels.length,0);
});
test('accepted new work resets idle but cached retries, GET and prepare never keep a finished round alive',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const a=await f.submit();await f.service.tick();await f.result(f.store.snapshot().channels.find(c=>c.requestId===a.lookupId));
 const first=(await f.prepare()).expiresAt;f.advance(120000);const b=await f.submit('new-unique-work','13900000001');assert.equal((await f.prepare()).expiresAt,null);await f.service.tick();await f.result(f.store.snapshot().channels.find(c=>c.requestId===b.lookupId));
 const end=(await f.prepare()).expiresAt;assert.equal(Date.parse(end)-Date.parse(first),120000);
 f.advance(120000);assert.equal((await f.submit()).lookupId,a.lookupId);assert.equal((await f.submit('cached-new-key')).lookupId,a.lookupId);await f.service.getAsyncResult(b.lookupId,'a');assert.equal((await f.prepare('new-prepare-no-renew')).expiresAt,end);
 f.advance(780000);await drain(f);assert.equal((await f.prepare()).status,'stopped');
});
test('restart preserves idle deadline and automatic stop waits for genuine ACK without touching another caller',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const original=(await f.prepare()).expiresAt;f.advance(899000);f.restart();assert.equal((await f.prepare()).expiresAt,original);
 f.offline.add('d51');await f.store.transact(s=>s.channels.push({deviceId:'other',clientId:'b',phase:'querying',generation:'other',sessionId:'other'}));f.obs.set('other',{busy:true});
 f.advance(1000);await drain(f);assert.equal((await f.prepare()).status,'stopping');assert.equal(f.events.some(e=>e.kind==='stop'&&e.device==='other'),false);await assert.rejects(f.prepare('new-while-unacked'),/lookup_round_stopping/);
 f.restart();await drain(f);assert.equal((await f.prepare()).status,'stopping');f.offline.clear();await drain(f);assert.equal((await f.prepare()).status,'stopped');assert.equal(f.store.snapshot().channels.length,1);
});
test('manual stop during business is immediate and never renewed by the idle policy',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const p=await f.prepare();await f.submit();await f.service.tick();
 await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'manual-stop-key'});f.advance(200000);await drain(f);assert.equal((await f.prepare()).status,'stopped');
 const next=await f.prepare('next-after-manual');await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'retry-old-stop-key'});assert.equal((await f.prepare('next-after-manual')).preparationId,next.preparationId);assert.equal((await f.prepare('next-after-manual')).status,'preparing');
});
test('legacy active lease migrates once; expired idle never revives, but accepted work remains protected',async()=>{
 for(const busy of [false,true]){
  const f=fixture();await f.configure([51,52]);await f.prepare();await f.store.transact(s=>{const p=s.preparations[0];delete p.idlePolicy;delete p.idleSince;delete p.idleTimeoutMs;p.expiresAt=f.now()-1;if(busy)s.requests.push({lookupId:'legacy-work',clientId:'a',status:'unknown',attempts:[]});});
  await f.service.tick();assert.equal((await f.prepare()).status,busy?'preparing':'stopped');if(busy)assert.equal((await f.prepare()).expiresAt,null);
 }
 const f=fixture();await f.configure();await f.prepare();await f.store.transact(s=>{const p=s.preparations[0];delete p.idlePolicy;delete p.idleSince;delete p.idleTimeoutMs;p.expiresAt=f.now()+1800000;});f.advance(1000);await f.service.tick();const deadline=(await f.prepare()).expiresAt;f.restart();await f.service.tick();assert.equal((await f.prepare()).expiresAt,deadline);
});
test('automatic cleanup is not blocked by exhausted user stop-key quota or revoked authorization',async()=>{
 const f=fixture();await f.configure();await f.prepare();await f.store.transact(s=>{s.roundStops=[{clientId:'a',preparationId:'history',keys:Array.from({length:1000},(_,i)=>'stop-key-'+i),status:'stopped'}];s.grants[0].enabled=false;});f.adapter.clientValid=()=>false;
 f.advance(900000);await f.service.tick();const p=f.store.snapshot().preparations[0];assert.ok(p.stoppedAt);assert.equal(f.store.snapshot().roundStops.at(-1).keys.length,0);
});

test('five-minute refresh cycles never renew fifteen-minute round expiry',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const deadline=(await f.prepare()).expiresAt;
 for(let i=0;i<2;i++){
  f.advance(300000);await f.service.tick();assert.equal((await f.prepare()).ready,true);assert.equal((await f.prepare()).readyCount,0);
  for(const c of f.store.snapshot().channels)await f.result(c);
  assert.equal((await f.prepare()).ready,true);assert.equal((await f.prepare()).expiresAt,deadline);
 }
 const before=f.events.filter(e=>e.kind==='query').length;f.advance(300000);await drain(f);
 assert.equal((await f.prepare()).status,'stopped');assert.equal(f.events.filter(e=>e.kind==='query').length,before);assert.equal(f.events.filter(e=>e.kind==='start').length,2);
});
