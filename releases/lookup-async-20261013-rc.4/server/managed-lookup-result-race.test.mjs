import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createManagedLookupService} from './managed-lookup.mjs';
import {createManagedLookupStore} from './managed-lookup-store.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';

async function fixture(t){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-result-race-'));
  const store=await createManagedLookupStore({file:path.join(temp,'state.json')});
  let clock=Date.now(),observation={busy:true};const events=[];
  await store.transact(s=>{s.config.enabled=true;s.config.concurrency=2;s.devices=[{deviceId:'fixture118',deviceNumber:118,enabled:true}];s.grants=[{clientId:'fixture',enabled:true,consentReference:'synthetic-consent'}];});
  const adapter={clientValid:()=>true,health:()=>({ready:true}),canStop:()=>true,validateDevice:()=>{},observe:()=>observation,
    start:async(c)=>{c.sessionId='synthetic-session';events.push('start');},
    query:async(c,r)=>{c.queryId=r.queryId='synthetic-query';events.push('query');},stop:async()=>{events.push('stop');}};
  const service=createManagedLookupService({store,adapter,now:()=>clock});
  const input={clientId:'fixture',phoneNumber:'13800000001',key:'original-key'};
  const {lookupId}=await service.submitAsync(input);await service.tick();observation={ready:true};await service.tick();observation={busy:true};
  t.after(async()=>{await service.close();await fs.rm(temp,{recursive:true,force:true});});
  const result=(status='succeeded')=>({resultId:'synthetic-query',status,name:status==='succeeded'?'测*':''});
  return {store,service,adapter,events,input,lookupId,result,set:o=>observation=o,advance:ms=>clock+=ms,read:()=>service.getAsyncResult(lookupId,'fixture')};
}
for(const reason of ['cancel','deadline'])for(const status of ['succeeded','not_found'])test(`${status} received before ${reason} is retained`,async t=>{
  const f=await fixture(t);if(reason==='cancel')await f.service.cancel(f.lookupId,'fixture');else f.advance(3600001);
  f.set({ready:true,result:f.result(status)});await f.service.tick();
  assert.equal((await f.read()).status,status);assert.equal((await f.read()).name,status==='succeeded'?'测*':'');assert.deepEqual(f.events,['start','query']);assert.equal(f.service.reserved('fixture118').requestId,'');
});
for(const lifecycle of [{busy:true},{unknown:true},{human:true},{recovery:true},{ready:false}])test(`result is readable while lifecycle remains unresolved ${JSON.stringify(lifecycle)}`,async t=>{
  const f=await fixture(t);f.set({...lifecycle,result:f.result()});await f.service.tick();
  assert.equal((await f.read()).name,'测*');assert.equal(f.service.reserved('fixture118').requestId,f.lookupId);assert.deepEqual(f.events,['start','query']);
  f.advance(121000);const retry=await f.service.submitAsync({...f.input,key:'another-key'});assert.equal(retry.lookupId,f.lookupId);
  const completedAt=f.store.snapshot().requests[0].completedAt;f.set({ready:true});await f.service.tick();assert.equal(f.service.reserved('fixture118').requestId,'');assert.equal(f.store.snapshot().requests[0].completedAt,completedAt);
});
test('result arriving during pending stop is readable before stop acknowledgment and never overwritten',async t=>{
  const f=await fixture(t);await f.service.cancel(f.lookupId,'fixture');await f.service.tick();
  f.set({busy:true,result:f.result()});await f.service.tick();assert.equal((await f.read()).name,'测*');assert.equal(f.service.reserved('fixture118').phase,'stopping');
  const completedAt=f.store.snapshot().requests[0].completedAt;await f.service.tick();assert.equal(f.store.snapshot().requests[0].completedAt,completedAt);
  f.advance(700000);const retry=await f.service.submitAsync({...f.input,key:'new-key-after-cache-window'});assert.equal(retry.lookupId,f.lookupId);assert.equal(f.events.filter(e=>e==='query').length,1);
  f.set({stopped:true});await f.service.tick();assert.equal((await f.read()).name,'测*');assert.equal(f.service.reserved('fixture118'),undefined);assert.equal(f.store.snapshot().requests[0].completedAt,completedAt);
});
test('received name commits before a later cleanup stop error',async t=>{
  const f=await fixture(t);await f.service.cancel(f.lookupId,'fixture');f.set({unknown:true,result:f.result()});f.adapter.stop=async()=>{throw Error('synthetic stop failure');};
  await f.service.tick();assert.equal((await f.read()).name,'测*');await assert.rejects(f.service.tick());assert.equal((await f.read()).name,'测*');assert.equal(f.service.reserved('fixture118').requestId,f.lookupId);
});
test('stop confirmation and original result in the same observation preserve result and release channel',async t=>{
  const f=await fixture(t);await f.service.cancel(f.lookupId,'fixture');await f.service.tick();f.set({stopped:true,result:f.result()});await f.service.tick();assert.equal((await f.read()).status,'succeeded');assert.equal(f.service.reserved('fixture118'),undefined);
});
test('confirmed stop without result still cancels and historical cancellation is not resurrected',async t=>{
  const f=await fixture(t);await f.service.cancel(f.lookupId,'fixture');await f.service.tick();f.set({stopped:true});await f.service.tick();assert.equal((await f.read()).code,'lookup_cancelled');f.set({ready:true,result:f.result()});await f.service.tick();assert.equal((await f.read()).status,'failed');assert.equal((await f.read()).name,'');
});
test('old query result cannot complete or cancel the current query',async t=>{
  const f=await fixture(t);f.set({ready:true,result:{...f.result(),resultId:'another-query'}});await f.service.tick();assert.equal((await f.read()).status,'processing');assert.equal(f.service.reserved('fixture118').requestId,f.lookupId);assert.deepEqual(f.events,['start','query']);
});
test('request and channel query binding must agree',async t=>{
  const f=await fixture(t);await f.store.transact(s=>{s.requests[0].queryId='different-query';});f.set({ready:true,result:f.result()});await f.service.tick();assert.equal((await f.read()).status,'processing');
});
test('completed result permits next queued phone number without waiting for a round',async t=>{
  const f=await fixture(t);const next=await f.service.submitAsync({...f.input,phoneNumber:'13800000002',key:'second-number'});f.set({ready:true,result:f.result()});await f.service.tick();assert.equal((await f.read()).name,'测*');assert.equal(f.service.reserved('fixture118').requestId,next.lookupId);assert.equal(f.events.filter(e=>e==='query').length,2);
});
for(const condition of ['pending-stop','offline','stalled','ended','expired','failed','human','recovery'])test(`real adapter exposes original completed result alongside ${condition}`,()=>{
  const session={sessionId:'s',status:'ready',results:[{resultId:'old-query',status:'succeeded',name:'旧*'},{resultId:'q',status:'succeeded',name:'测*'}]};
  const state={devices:[{deviceId:'d'}],automationSessions:[session],automationJobs:[{jobId:'j',windowsTaskId:'t'}],windowsTasks:[{taskId:'t',status:'running'}]};
  if(['pending-stop','offline','stalled'].includes(condition)){session.pendingJobId='j';session.status='stopping';if(condition==='stalled')state.windowsTasks[0].status='stalled';}
  if(['ended','expired','failed'].includes(condition))session.status=condition;
  if(condition==='human')session.status='needs_human_verification';if(condition==='recovery')session.startupHumanVerification={status:'needs_recovery'};
  const adapter=createManagedLookupAdapter({state,online:()=>condition!=='offline'}),o=adapter.observe({sessionId:'s',queryId:'q',deviceId:'d'});
  assert.equal(o.result?.name,'测*');if(condition==='pending-stop')assert.equal(o.busy,true);if(['offline','stalled'].includes(condition))assert.equal(o.unknown,true);if(['ended','failed'].includes(condition))assert.equal(o.stopped,true);if(condition==='expired')assert.equal(o.stopped,false);if(condition==='human')assert.equal(o.human,true);if(condition==='recovery')assert.equal(o.recovery,true);
});
