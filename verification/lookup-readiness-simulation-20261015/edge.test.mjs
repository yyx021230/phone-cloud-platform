import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from '../../releases/lookup-readiness-20261015-rc.1/server/managed-lookup.mjs';import {initialManagedLookupState} from '../../releases/lookup-readiness-20261015-rc.1/server/managed-lookup-store.mjs';
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

const businessQueries=(f,id)=>f.events.filter(e=>e.kind==='query'&&!e.purpose&&(!id||e.id===id));
async function limitCurrent(f,id){
 const c=f.store.snapshot().channels.find(c=>c.requestId===id);assert.ok(c);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});
 await f.service.tick();await f.service.tick();return c;
}
async function finishProbes(f){
 for(const original of f.store.snapshot().channels){
  let c=f.store.snapshot().channels.find(c=>c.deviceId===original.deviceId);
  if(f.store.snapshot().requests.find(r=>r.lookupId===c?.requestId)?.purpose!=='readiness_probe')continue;
  if(c.phase==='starting')await f.readyStart(c);
  c=f.store.snapshot().channels.find(c=>c.deviceId===original.deviceId);await f.result(c,'Probe');
 }
}
test('both ready phones hit limits consecutively; original waits then resumes only after a new successful probe',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();
 const first=await limitCurrent(f,r.lookupId),second=await limitCurrent(f,r.lookupId);assert.notEqual(first.deviceId,second.deviceId);
 assert.equal(businessQueries(f,r.lookupId).length,2);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'queued');
 const retries=await Promise.all(Array.from({length:40},(_,i)=>f.submit('both-limited-retry-'+i)));assert.ok(retries.every(x=>x.lookupId===r.lookupId));
 f.advance(31000);for(const id of ['d51','d52'])f.epochs.set(id,'new-account:agent-1');await f.service.tick();assert.equal(businessQueries(f,r.lookupId).length,2);
 await finishProbes(f);const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.ok(c?.readinessProof);assert.notEqual(c.generation,first.generation);assert.notEqual(c.generation,second.generation);
 await f.result(c,'Recovered');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'Recovered');assert.equal(businessQueries(f,r.lookupId).length,3);
});
test('all phones disconnect before dispatch; reconnect does not reuse old proof or lose queued request',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();for(const id of ['d51','d52'])f.offline.add(id);await f.service.tick();assert.equal(businessQueries(f).length,0);
 assert.equal((await f.prepare()).readyCount,0);assert.equal((await f.submit('offline-replay-key')).lookupId,r.lookupId);
 f.offline.clear();f.advance(31000);await f.service.tick();assert.equal(businessQueries(f).length,0);assert.equal((await f.prepare()).ready,false);
 await finishProbes(f);const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);assert.ok(c?.readinessProof);await f.result(c,'Back');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'Back');assert.equal(businessQueries(f).length,1);
});
test('ordinary failed result cannot impersonate confirmed limit and trigger a second phone query',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'failed'}});await f.service.tick();await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'failed');assert.equal(businessQueries(f,r.lookupId).length,1);
});
test('eight-hour cooldown boundary uses simulated clock and replay does not extend it',async()=>{
 const {recordLookupAccountCooldown,allSavedAccountsCooling}=await import('../../releases/lookup-readiness-20261015-rc.1/server/lookup-account-cooldown.mjs');
 const now=Date.now(),d={},saved=[{account:'synthetic',current:true}],input={account:'synthetic',reason:'access_denied',restrictionId:'synthetic-job:synthetic',jobId:'synthetic-job',accountIdentityVerified:true,phoneQueryStarted:true,detectedAt:new Date(now).toISOString()};
 const original=recordLookupAccountCooldown(d,input,now);assert.equal(allSavedAccountsCooling(d,saved,now+28800000-1),true);
 assert.equal(recordLookupAccountCooldown(d,input,now+28799999).cooldownUntil,original.cooldownUntil);assert.equal(allSavedAccountsCooling(d,saved,now+28800000),false);
});
test('100 accepted numbers drain independently across five proven phones without duplicates or more than five executions',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87]);await f.prepare();await f.service.tick();await finishProbes(f);assert.equal((await f.prepare()).readyCount,5);
 const requests=await Promise.all(Array.from({length:100},(_,i)=>f.submit('load-key-'+i,'139'+String(i).padStart(8,'0'))));await f.service.tick();let max=0;
 for(let n=0;n<100;n++){
  const s=f.store.snapshot(),active=s.channels.filter(c=>s.requests.find(r=>r.lookupId===c.requestId)?.purpose!=='readiness_probe'&&c.phase==='querying');max=Math.max(max,active.length);assert.ok(active.length<=5);assert.ok(active.length>0);assert.equal(new Set(active.map(c=>c.deviceId)).size,active.length);
  const c=active[n%active.length];assert.ok(c.readinessProof);await f.result(c,n%2?'Name':'',n%2?'succeeded':'not_found');
 }
 const results=await Promise.all(requests.map(r=>f.service.getAsyncResult(r.lookupId,'a')));assert.ok(results.every(r=>r.status==='completed'&&typeof r.name==='string'));assert.equal(max,5);assert.equal(businessQueries(f).length,100);assert.equal(new Set(businessQueries(f).map(q=>q.id)).size,100);
});
