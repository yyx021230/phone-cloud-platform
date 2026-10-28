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

import {recordLookupPreparationFailure,preparationBlocked,pagePreparationRetryAt} from './lookup-device-availability.mjs';
const oldIssue=(s,d,at,domain='page')=>{d.preparationIssue={domain,code:'alipay_page_element_changed',at,rounds:[{clientId:'a',preparationId:s.preparations[0].preparationId,count:2}]};};
test('page failures use persisted 1/5/15 minute backoff; old two-failure records become retryable without clearing the proof gate',()=>{
 const s={devices:[{deviceId:'d'}],preparations:[{clientId:'a',preparationId:'p'}]},d=s.devices[0],c={clientId:'a',deviceId:'d'};
 for(const [at,delay] of [[1000,60000],[61000,300000],[361000,900000],[1261000,900000]]){recordLookupPreparationFailure(s,c,{},at,{domain:'page',code:'alipay_page_element_changed'});assert.equal(d.quarantineUntil,at+delay);}
 assert.equal(preparationBlocked(s,d,'a'),true);assert.equal(d.prepareFailureCount,undefined);assert.equal(d.lookupUnavailable,undefined);
 delete d.preparationIssue.retryAt;d.preparationIssue.rounds[0].count=2;assert.equal(pagePreparationRetryAt(s,d,'a'),1261000+300000);
 assert.equal(pagePreparationRetryAt(s,d,'other'),null);d.preparationIssue.domain='unknown';assert.equal(pagePreparationRetryAt(s,d,'a'),null);
});
test('long-running round fills from two to five with paced legacy-page reprobes and preserves 20 queued business IDs',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();await f.configure([51,52,54,55,87,138]);
 await f.store.transact(s=>{for(const d of s.devices.filter(d=>!['d51','d52'].includes(d.deviceId)))oldIssue(s,d,Date.now()-3600000);});
 const ids=await Promise.all(Array.from({length:20},(_,i)=>f.submit('reprobe-business-'+i,'13900001'+String(i).padStart(3,'0'))));
 await f.service.tick();assert.equal(f.store.snapshot().channels.length,3);
 let peak=0;
 for(let step=0;step<200;step++){
  await f.service.tick();const s=f.store.snapshot();peak=Math.max(peak,s.channels.length);assert.ok(s.channels.length<=5);
  for(const c of s.channels){const req=s.requests.find(r=>r.lookupId===c.requestId);if(c.phase==='starting')f.obs.set(c.deviceId,{ready:true});else if(c.phase==='querying')f.obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId,status:'succeeded',name:'测'}});}
  if(s.channels.filter(c=>c.readinessProof).length===5&&ids.every(x=>s.requests.find(r=>r.lookupId===x.lookupId).status==='succeeded'))break;
  f.advance(1000);
 }
 assert.equal(peak,5);assert.equal(f.store.snapshot().channels.filter(c=>c.readinessProof).length,5);
 for(const id of ids)assert.equal((await f.service.getAsyncResult(id.lookupId,'a')).status,'completed');
 assert.equal(f.events.filter(e=>e.kind==='query'&&ids.some(id=>id.lookupId===e.id)).length,20);
 const retries=f.store.snapshot().requests.filter(r=>r.pageReprobe);assert.equal(retries.length,3);
 for(let i=1;i<retries.length;i++)assert.ok(Date.parse(retries[i].createdAt)-Date.parse(retries[i-1].createdAt)>=60000);
});
test('restart and prepare polling do not bypass retry spacing or start a second executing page reprobe',async()=>{
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.store.transact(s=>{for(const d of s.devices)oldIssue(s,d,Date.now()-3600000);});
 await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);f.restart();f.advance(61000);await f.prepare('new-key-same-round');await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);
 await fail(f,f.store.snapshot().channels[0].deviceId);await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);
});
test('unused candidates outrank page reprobes; all five reservations including human and stopping still bound capacity',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138]);await f.prepare();await f.store.transact(s=>oldIssue(s,s.devices[0],Date.now()-3600000));await f.service.tick();
 assert.equal(f.store.snapshot().channels.length,5);assert.ok(!f.store.snapshot().channels.some(c=>c.deviceId==='d51'));
 f.obs.set('d52',{human:true});await f.service.tick();assert.equal(f.store.snapshot().channels.length,5);assert.ok(!f.store.snapshot().channels.some(c=>c.deviceId==='d51'));
});
test('page retry never bypasses login exclusion, device isolation, cooling, occupied controls or unknown errors',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87]);await f.prepare();
 await f.store.transact(s=>{for(const d of s.devices)oldIssue(s,d,Date.now()-3600000);s.devices[0].accountOffline={blockedRounds:[{clientId:'a',preparationId:s.preparations[0].preparationId,epoch:s.preparations[0].loginEpoch}]};s.devices[1].lookupUnavailable=true;s.devices[4].preparationIssue.domain='unknown';});
 f.offline.add('d54');f.offline.add('d55');await f.service.tick();assert.equal(f.events.length,0);
});
test('stopped round does not re-probe old page failures',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.store.transact(s=>oldIssue(s,s.devices[0],Date.now()-3600000));
 await f.service.stopRound({clientId:'a',key:'stop-page-reprobe',preparationId:f.store.snapshot().preparations[0].preparationId});f.advance(900000);await f.service.tick();assert.equal(f.events.length,0);
});
test('a failed re-probe increases backoff and the next due phone gets the slot instead of repeatedly selecting the same one',async()=>{
 const f=fixture();f.adapter.preparationFailure=()=>({domain:'page',code:'alipay_page_element_changed'});await f.configure([51,52]);await f.prepare();
 await f.store.transact(s=>{for(const d of s.devices)oldIssue(s,d,Date.now()-3600000);});await f.service.tick();const first=f.store.snapshot().channels[0].deviceId;await fail(f,first);
 let state=f.store.snapshot(),d=state.devices.find(d=>d.deviceId===first);assert.equal(d.preparationIssue.rounds[0].count,3);assert.equal(d.preparationIssue.retryAt-d.preparationIssue.at,900000);
 assert.equal(state.channels.length,0);f.advance(60000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);assert.notEqual(f.store.snapshot().channels[0].deviceId,first);
});
test('old failed execution keeps its reservation until stop ACK and blocks a concurrent re-probe',async()=>{
 const f=fixture();f.adapter.preparationFailure=()=>({domain:'page',code:'alipay_page_element_changed'});await f.configure([51,52]);await f.prepare();await f.store.transact(s=>{for(const d of s.devices)oldIssue(s,d,Date.now()-3600000);});await f.service.tick();
 const first=f.store.snapshot().channels[0];f.adapter.stop=async()=>{};f.obs.set(first.deviceId,{startFailed:true,ready:false});await f.service.tick();f.advance(61000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);assert.equal(f.store.snapshot().channels[0].phase,'stopping');
 f.obs.set(first.deviceId,{stopped:true});await f.service.tick();assert.equal(f.store.snapshot().channels.length,1);assert.notEqual(f.store.snapshot().channels[0].deviceId,first.deviceId);
});
test('fresh candidate success cannot admit business on a page-retry phone until its own named probe succeeds',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();await f.configure([51,52,54]);await f.store.transact(s=>oldIssue(s,s.devices.find(d=>d.deviceId==='d54'),Date.now()-3600000));await f.service.tick();
 const retry=f.store.snapshot().channels.find(c=>c.deviceId==='d54');assert.ok(retry);assert.equal(f.service.admin().devices.find(d=>d.deviceId==='d54').health.reason,'page_preparation_backoff');
 const r=await f.submit();await f.service.tick();assert.notEqual(f.store.snapshot().channels.find(c=>c.requestId===r.lookupId).deviceId,'d54');await f.readyStart(retry);assert.equal(f.store.snapshot().channels.find(c=>c.deviceId==='d54').readinessProof,undefined);await f.result(retry);assert.ok(f.store.snapshot().channels.find(c=>c.deviceId==='d54').readinessProof);assert.equal(f.store.snapshot().devices.find(d=>d.deviceId==='d54').preparationIssue,undefined);
});
test('unknown post-human probe page records one page failure and retains at least five minutes before re-probing',async()=>{
 const f=fixture();await f.configure([51]);await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];await f.readyStart(c);
 f.obs.set(c.deviceId,{recovery:true,postHumanPageUnknown:true,recoveryFailure:{domain:'page',jobId:'page-unknown'}});await f.service.tick();const d=f.store.snapshot().devices[0];assert.equal(d.preparationIssue.domain,'page');assert.equal(d.preparationIssue.rounds[0].count,1);assert.ok(d.quarantineUntil-d.preparationIssue.at>=300000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,0);assert.equal(f.store.snapshot().devices[0].preparationIssue.rounds[0].count,1);
});
