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
 const f=fixture();await f.configure();await f.twoReady();const p=await f.prepare();f.advance(121000);await f.service.tick();assert.equal((await f.prepare()).readyCount,2);assert.equal((await f.prepare()).expiresAt,p.expiresAt);f.advance(1800000);assert.equal((await f.prepare()).status,'expired');await assert.rejects(f.submit(),/lookup_not_ready/);await assert.rejects(f.prepare('next-round-key'),/lookup_round_stopping/);await f.service.tick();await f.service.tick();await f.service.tick();const q=await f.prepare('next-round-key');assert.notEqual(q.preparationId,p.preparationId);
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


test('a finished probe cannot lend its human-wait timer to a later business query',async()=>{
 const f=fixture();await f.configure([51,52]);await f.service.configure({humanWaitMs:1000},'test');await f.prepare();await f.service.tick();
 for(const c of f.store.snapshot().channels){await f.readyStart(c);f.obs.set(c.deviceId,{human:true});await f.service.tick();await f.result(c);}
 f.advance(2000);const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.ok(c);
 f.obs.set(c.deviceId,{human:true});await f.service.tick();const state=f.store.snapshot();assert.equal(state.requests.find(x=>x.lookupId===r.lookupId).cancelRequested,undefined);assert.equal(state.channels.find(x=>x.deviceId===c.deviceId).phase,'human');
 f.advance(999);await f.service.tick();assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).cancelRequested,undefined);
 f.advance(1);await f.service.tick();assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).cancelReason,'lookup_manual_wait_expired');
});

test('ordinary result reuse clears a previous business human-wait timer too',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const first=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===first.lookupId);
 f.obs.set(c.deviceId,{human:true});await f.service.tick();assert.ok(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).humanSince);
 await f.result(c,'名');const released=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);assert.equal(released.phase,'idle');assert.equal(released.humanSince,undefined);assert.equal((await f.service.getAsyncResult(first.lookupId,'a')).name,'名');
});

test('five accepted requests use two ready phones; newly proved phones immediately take queued work',async()=>{
 const f=fixture();await f.configure();const ready=await f.twoReady();
 const submitted=await Promise.all(Array.from({length:5},(_,i)=>f.submit('five-window-'+i,'1390000010'+i)));
 await f.service.tick();let s=f.store.snapshot();const business=()=>f.store.snapshot().requests.filter(r=>r.purpose!=='readiness_probe');
 assert.equal(business().filter(r=>r.status==='running').length,2);assert.equal(business().filter(r=>r.status==='queued').length,3);
 const third=s.channels.find(c=>!ready.some(x=>x.deviceId===c.deviceId));await f.readyStart(third);await f.result(third);
 s=f.store.snapshot();assert.equal(business().filter(r=>r.status==='running').length,3);assert.equal(business().filter(r=>r.status==='queued').length,2);
 const thirdBusiness=s.channels.find(c=>c.deviceId===third.deviceId);assert.equal(thirdBusiness.requestId,submitted[2].lookupId);
 await f.result(thirdBusiness,'先');assert.equal((await f.service.getAsyncResult(submitted[2].lookupId,'a')).name,'先');
 assert.equal((await f.service.getAsyncResult(submitted[0].lookupId,'a')).status,'processing');
 assert.equal((await f.service.getAsyncResult(submitted[1].lookupId,'a')).status,'processing');
 assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===third.deviceId).requestId,submitted[3].lookupId);
});

test('parallel admission is capped at five canonical unfinished jobs, with dedup before the cap',async()=>{
 const f=fixture();await f.configure();await f.service.configure({preparedClientInflightLimit:5},'test');await f.twoReady();
 const outcomes=await Promise.allSettled(Array.from({length:10},(_,i)=>f.submit('race-five-'+i,'1390000020'+i)));
 const accepted=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);
 assert.equal(accepted.length,5);for(const x of outcomes.filter(x=>x.status==='rejected')){assert.equal(x.reason.message,'lookup_inflight_limit');assert.equal(x.reason.statusCode,429);}
 await f.service.tick();f.advance(121000);
 assert.equal((await f.submit('race-five-0','13900000200')).lookupId,accepted[0].lookupId);
 assert.equal((await f.submit('new-timeout-key','13900000200')).lookupId,accepted[0].lookupId);
 assert.equal(f.store.snapshot().requests.filter(r=>r.purpose!=='readiness_probe').length,5);
 const c=f.store.snapshot().channels.find(c=>c.requestId===accepted[0].lookupId);await f.result(c,'完成');
 const next=await f.submit('race-five-5','13900000205');assert.ok(next.lookupId);
 await assert.rejects(f.submit('still-at-cap','13900000206'),{statusCode:429,message:'lookup_inflight_limit'});
});

test('human, recovery and unknown requests retain their slot without blocking queued work on a healthy phone',async()=>{
 for(const observation of [{human:true},{recovery:true},{unknown:true}]){
  const f=fixture();await f.configure([51,52]);await f.service.configure({preparedClientInflightLimit:5},'test');await f.twoReady();
  const rows=await Promise.all(Array.from({length:5},(_,i)=>f.submit('held-slot-'+i,'1390000030'+i)));await f.service.tick();
  let channels=f.store.snapshot().channels;const blocked=channels.find(c=>c.requestId===rows[0].lookupId),healthy=channels.find(c=>c.requestId===rows[1].lookupId);
  f.obs.set(blocked.deviceId,observation);await f.service.tick();await assert.rejects(f.submit('blocked-still-counts','13900000309'),{statusCode:429,message:'lookup_inflight_limit'});await f.result(healthy,'正常');
  assert.equal((await f.service.getAsyncResult(rows[1].lookupId,'a')).name,'正常');
  assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===healthy.deviceId).requestId,rows[2].lookupId);
  assert.equal((await f.submit('held-retry-new-key','13900000300')).lookupId,rows[0].lookupId);
  assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===blocked.deviceId).requestId,rows[0].lookupId);
 }
});

test('twenty canonical jobs queue on two proven phones, refill to five, and finish independently',async()=>{
 const f=fixture();await f.configure();await f.store.transact(s=>{delete s.config.preparedClientInflightLimit;});const ready=await f.twoReady();
 const outcomes=await Promise.allSettled(Array.from({length:25},(_,i)=>f.submit('queue-twenty-'+i,'1390000'+String(i).padStart(4,'0'))));
 const accepted=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);assert.equal(accepted.length,20);
 for(const x of outcomes.filter(x=>x.status==='rejected'))assert.equal(x.reason.message,'lookup_inflight_limit');
 await f.service.tick();const business=()=>f.store.snapshot().requests.filter(r=>r.purpose!=='readiness_probe');
 assert.equal(business().filter(r=>r.status==='running').length,2);assert.equal(business().filter(r=>r.status==='queued').length,18);
 f.advance(121000);assert.equal((await f.submit('changed-key-after-timeout','13900000000')).lookupId,accepted[0].lookupId);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===accepted[0].lookupId).length,1);
 for(const c of f.store.snapshot().channels.filter(c=>!ready.some(r=>r.deviceId===c.deviceId))){await f.readyStart(c);await f.result(c);assert.ok(f.service.admin().counts.executing<=5);}
 assert.equal(business().filter(r=>r.status==='running').length,5);assert.equal(business().filter(r=>r.status==='queued').length,15);
 const c=f.store.snapshot().channels.find(c=>c.requestId===accepted[2].lookupId);await f.result(c,'先完成');
 assert.equal((await f.service.getAsyncResult(accepted[2].lookupId,'a')).name,'先完成');assert.equal((await f.service.getAsyncResult(accepted[0].lookupId,'a')).status,'processing');
 await f.submit('replacement-job-20','13900000020');
 let guard=0;while(business().some(r=>!r.completedAt)&&guard++<25){const channel=f.store.snapshot().channels.find(c=>c.requestId&&business().some(r=>r.lookupId===c.requestId));assert.ok(channel);await f.result(channel);assert.ok(f.service.admin().counts.executing<=5);}
 assert.equal(business().length,21);assert.ok(business().every(r=>r.status==='succeeded'));
 for(const r of business())assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
});

test('lowering admission window preserves accepted jobs, dedup, and one blocked phone while others drain',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const rows=await Promise.all(Array.from({length:20},(_,i)=>f.submit('lower-cap-'+i,'1370000'+String(i).padStart(4,'0'))));await f.service.tick();
 const blocked=f.store.snapshot().channels.find(c=>c.requestId===rows[0].lookupId);f.obs.set(blocked.deviceId,{human:true});await f.service.tick();
 await f.service.configure({preparedClientInflightLimit:10},'test');assert.equal(f.store.snapshot().requests.filter(r=>r.purpose!=='readiness_probe').length,20);
 assert.equal((await f.submit('lowered-cap-replay','13700000000')).lookupId,rows[0].lookupId);await assert.rejects(f.submit('lowered-cap-new','13600000000'),/lookup_inflight_limit/);
 const healthy=f.store.snapshot().channels.find(c=>c.deviceId!==blocked.deviceId);await f.result(healthy,'好');assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===healthy.deviceId).requestId,rows[2].lookupId);
 assert.equal((await f.service.getAsyncResult(rows[0].lookupId,'a')).status,'processing');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===rows[0].lookupId).length,1);
});

test('admission limit validates independently from phone concurrency and survives coordinator recreation',async()=>{
 const f=fixture();await f.configure([51,52]);for(const n of [0,201,1.5,'bad'])await assert.rejects(f.service.configure({preparedClientInflightLimit:n},'test'));
 await f.service.configure({preparedClientInflightLimit:40},'test');assert.equal(f.service.admin().config.concurrency,5);f.restart();assert.equal(f.service.admin().config.preparedClientInflightLimit,40);
 await assert.rejects(f.service.configure({concurrency:6},'test'));
});

// rc.16: freshness, bounded recovery priority, human isolation and standby selection.
async function allReady(f){await f.prepare();await f.service.tick();for(const c of f.store.snapshot().channels){await f.readyStart(c);await f.result(c);}return f.store.snapshot().channels;}
test('idle proof expires exactly at four minutes; a completed pool does not probe without demand',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87]);await allReady(f);const n=f.events.filter(e=>e.kind==='query').length;
 f.advance(239999);assert.equal((await f.prepare()).ready,true);
 // Polling a fully ready pool must not schedule unnecessary refreshes later.
 assert.equal(f.store.snapshot().preparations[0].probeDemand,false);
 f.advance(1);assert.equal(f.service.admin().channels.filter(c=>c.readinessProof).length,5);
 await assert.rejects(f.submit(),/lookup_not_ready/);await f.service.tick();await f.service.tick();await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='query').length,n);assert.equal(f.store.snapshot().channels.length,0);
 const status=await f.prepare();assert.equal(status.ready,false);await f.service.tick();assert.equal(f.store.snapshot().channels.length,5);
 for(const c of f.store.snapshot().channels){await f.readyStart(c);await f.result(c);}assert.equal((await f.prepare()).ready,true);
});
test('successful named and empty queries refresh freshness; unknown and human do not',async()=>{
 for(const [status,name] of [['succeeded','名'],['not_found','']]){
  const f=fixture();await f.configure([51,52]);await f.twoReady();f.advance(200000);
  const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);
  f.advance(50000);await f.result(c,name,status);const proof=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).readinessProof;assert.ok(proof);
  assert.ok(proof.lastSuccessAt>proof.verifiedAt);f.advance(239999);assert.equal((await f.prepare()).readyCount,1);f.advance(1);assert.equal((await f.prepare()).readyCount,0);
 }
});
test('expiry never duplicates a running request, new-key retry or pending stop',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);
 f.advance(360000);await f.service.tick();assert.equal((await f.submit('stale-retry-key')).lookupId,r.lookupId);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'querying');
 f.obs.set(c.deviceId,{unknown:true});await f.service.tick();assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).readinessProof,undefined);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
});
test('five humans do not block queued business on healthy phones and do cap new probes',async()=>{
 const f=fixture();await f.configure();await f.twoReady();
 for(const c of f.store.snapshot().channels.filter(c=>!c.readinessProof))f.obs.set(c.deviceId,{human:true});await f.service.tick();
 for(const c of f.store.snapshot().channels.filter(c=>!c.readinessProof))f.obs.set(c.deviceId,{human:true});await f.service.tick();
 assert.equal(f.service.admin().counts.waitingHuman,5);const starts=f.events.filter(e=>e.kind==='start').length;
 const rows=await Promise.all(Array.from({length:5},(_,i)=>f.submit('human-cap-business-'+i,'1390000200'+i)));await f.service.tick();
 assert.equal(f.store.snapshot().requests.filter(r=>rows.some(x=>x.lookupId===r.lookupId)&&r.status==='running').length,2);
 const c=f.store.snapshot().channels.find(c=>c.requestId===rows[0].lookupId);await f.result(c);assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).requestId,rows[2].lookupId);
 assert.equal(f.events.filter(e=>e.kind==='start').length,starts);assert.equal(f.service.admin().counts.waitingHuman,5);
});
test('manual recovery gets exactly one priority dispatch, then normal fairness',async()=>{
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.service.tick();const cs=f.store.snapshot().channels;
 for(const c of cs)await f.readyStart(c);await f.result(cs[0]);f.obs.set(cs[1].deviceId,{human:true});await f.service.tick();f.advance(60000);await f.result(cs[1]);
 const r=await f.submit();await f.service.tick();let c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.equal(c.deviceId,cs[1].deviceId);assert.equal(c.readinessPriorityAt,undefined);
 await f.result(c);const second=await f.submit('after-priority-key','13900000001');await f.service.tick();assert.equal(f.store.snapshot().channels.find(x=>x.requestId===second.lookupId).deviceId,cs[0].deviceId);
});
test('expired recovered proof loses priority and cannot receive business before new probe',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const c=f.store.snapshot().channels[1];await f.store.transact(s=>{s.channels[1].readinessPriorityAt=1;});
 f.advance(240000);await f.service.tick();assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId)?.readinessPriorityAt,undefined);
 await assert.rejects(f.submit(),/lookup_not_ready/);
});
test('fresh unused substitute wins over retrying an unhealthy fifth; all active slots stay bounded',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138]);await f.prepare();await f.service.tick();const cs=f.store.snapshot().channels;
 for(const c of cs.slice(0,4)){await f.readyStart(c);await f.result(c);}const bad=cs[4];f.offline.add(bad.deviceId);f.obs.set(bad.deviceId,{startFailed:true,stopped:true,ready:false});await f.service.tick();
 assert.ok(f.events.some(e=>e.kind==='start'&&e.device==='d138'));const replacement=f.store.snapshot().channels.find(c=>c.deviceId==='d138');await f.readyStart(replacement);await f.result(replacement);
 assert.equal((await f.prepare()).readyCount,5);const rows=await Promise.all(Array.from({length:20},(_,i)=>f.submit('substitute-queue-'+i,'13900003'+String(i).padStart(3,'0'))));await f.service.tick();
 assert.equal(f.service.admin().counts.executing,5);assert.equal(f.store.snapshot().requests.filter(r=>rows.some(x=>x.lookupId===r.lookupId)&&r.status==='queued').length,15);
 assert.ok(!f.store.snapshot().channels.some(c=>c.deviceId===bad.deviceId));
});
test('standby selection skips disabled, unhealthy, occupied and isolated phones',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138,152,188]);await f.prepare();await f.service.tick();const cs=f.store.snapshot().channels;
 for(const c of cs.slice(0,4)){await f.readyStart(c);await f.result(c);}
 await f.store.transact(s=>{s.devices.find(d=>d.deviceId==='d138').enabled=false;s.devices.find(d=>d.deviceId==='d152').lookupUnavailable=true;});
 const bad=cs[4];f.offline.add(bad.deviceId);f.obs.set(bad.deviceId,{startFailed:true,stopped:true,ready:false});await f.service.tick();
 assert.ok(f.events.some(e=>e.kind==='start'&&e.device==='d188'));assert.ok(!f.events.some(e=>e.kind==='start'&&['d138','d152'].includes(e.device)));
});
test('unknown executions reserve capacity; standby probes do not create a sixth execution',async()=>{
 const f=fixture();await f.configure();await allReady(f);await Promise.all(Array.from({length:5},(_,i)=>f.submit('unknown-cap-'+i,'1390000400'+i)));await f.service.tick();
 const cs=f.store.snapshot().channels;f.obs.set(cs[0].deviceId,{unknown:true});await f.service.tick();
 assert.equal(f.service.admin().counts.executing,5);assert.equal(f.events.filter(e=>e.kind==='start').length,5);
});

test('after backoff, never-tried standby wins over the recovered failed phone',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138]);await f.store.transact(s=>{s.devices.find(d=>d.deviceId==='d138').enabled=false;});await f.prepare();await f.service.tick();
 const cs=f.store.snapshot().channels;for(const c of cs.slice(0,4)){await f.readyStart(c);await f.result(c);}f.obs.set('d87',{startFailed:true,stopped:true,ready:false});await f.service.tick();await f.service.tick();
 f.advance(31000);await f.store.transact(s=>{s.devices.find(d=>d.deviceId==='d138').enabled=true;});await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='start'&&e.device==='d87').length,1);assert.ok(f.events.some(e=>e.kind==='start'&&e.device==='d138'));
});
test('human limit still prevents legacy callers from opening unprepared channels',async()=>{
 const f=fixture();await f.configure([51,52]);await f.service.configure({humanLimit:1},'test');const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);f.obs.set(c.deviceId,{human:true});await f.service.tick();const second=await f.submit('legacy-new-human','13900000001');await f.service.tick();
 assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===second.lookupId).status,'queued');assert.equal(f.events.filter(e=>e.kind==='start').length,1);
});
