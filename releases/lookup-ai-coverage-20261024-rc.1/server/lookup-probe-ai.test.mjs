import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createManagedLookupStore} from './managed-lookup-store.mjs';
import {createManagedLookupService} from './managed-lookup.mjs';
import {createLookupAiRecovery} from './lookup-ai-recovery.mjs';
const phone='13800000000', sha='a'.repeat(64);
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'probe-ai-'));
 const store=await createManagedLookupStore({file:path.join(dir,'state.json')});
 let clock=Date.now();const obs=new Map(),events=[],blocked=new Set();
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!blocked.has(id)}),canStop:()=>true,readinessIdentity:c=>'account:'+c.generation,
  observe:c=>obs.get(c.deviceId)||{busy:true},
  start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push(['start',c.deviceId]);obs.set(c.deviceId,{busy:true});},
  query:async(c,r)=>{c.queryIdentity=adapter.readinessIdentity(c);c.queryId=r.queryId='q-'+r.lookupId;events.push(['query',c.deviceId]);obs.set(c.deviceId,{busy:true});},
  stop:async c=>{events.push(['stop',c.deviceId]);obs.set(c.deviceId,{stopped:true});},
  aiEvidence:c=>({jobId:'job-'+c.deviceId,taskId:'task-'+c.deviceId,evidenceId:'image-'+c.deviceId,evidenceSha256:sha,mimeType:'image/png'}),
  recordAiResult:async(c,r,tx)=>{const old=obs.get(c.deviceId);tx.onRollback(()=>obs.set(c.deviceId,old));obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId,status:r.status,name:r.name}});}
 };
 const make=()=>createManagedLookupService({store,adapter,probePhone:phone,now:()=>clock,aiEnabled:true});const service=make();
 t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
 await service.configure({enabled:true,devices:[51,52].map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'synthetic-test'}]},'test');
 await service.prepare({clientId:'a',key:'prepare-test-1'});await service.tick();
 for(const c of store.snapshot().channels)obs.set(c.deviceId,{ready:true});
 await service.tick();
 const fail=(id='d51',postHuman=false)=>{const c=store.snapshot().channels.find(c=>c.deviceId===id);obs.set(id,{recovery:true,postHumanPageUnknown:postHuman,recoveryFailure:{jobId:'job-'+id,domain:'page',identity:c.queryIdentity,reason:'local_lookup_result_unconfirmed:observation_budget_exhausted'}});};
 const name=b=>({kind:'name',name:'测试(**甲)',matchedPhone:phone,evidenceSha256:b.evidenceSha256});
 return {store,service,adapter,events,obs,blocked,fail,name,make,advance:ms=>clock+=ms};
}
for(const postHuman of [false,true])test('probe AI name earns readiness; second probe opens admission; original query never resubmitted '+postHuman,async t=>{
 const f=await fixture(t);f.fail('d51',postHuman);await f.service.tick();
 let b={...f.service.aiCandidates()[0],token:'one'};assert.ok(b.lookupId);assert.equal(await f.service.claimAiReading(b),true);
 await f.service.tick();assert.equal(f.events.filter(e=>e[0]==='query').length,2);
 assert.equal(await f.service.finishAiReading(b,f.name(b)),true);await f.service.tick();
 assert.equal((await f.service.prepare({clientId:'a',key:'prepare-test-1'})).readyCount,1);
 f.fail('d52',true);await f.service.tick();b={...f.service.aiCandidates()[0],token:'two'};await f.service.claimAiReading(b);await f.service.finishAiReading(b,f.name(b));await f.service.tick();
 assert.equal((await f.service.prepare({clientId:'a',key:'prepare-test-1'})).ready,true);
 const q=await f.service.submitAsync({clientId:'a',key:'business-key',phoneNumber:'13900000000'});await f.service.tick();assert.ok(f.store.snapshot().channels.some(c=>c.requestId===q.lookupId));
 assert.equal(f.events.filter(e=>e[0]==='stop').length,0);
});
for(const kind of ['no_name','unverified','unconfirmed','timeout','wrongPhone','wrongHash'])test('unclear or empty probe never grants readiness: '+kind,async t=>{
 const f=await fixture(t);f.fail();await f.service.tick();const b={...f.service.aiCandidates()[0],token:'one'};assert.ok(b.lookupId);await f.service.claimAiReading(b);
 const result=kind==='wrongPhone'?{...f.name(b),matchedPhone:'13900000000'}:kind==='wrongHash'?{...f.name(b),evidenceSha256:'b'.repeat(64)}:{kind,matchedPhone:phone,evidenceSha256:sha};
 await f.service.finishAiReading(b,result);await f.service.tick();
 assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===b.lookupId).status,'failed');assert.equal(f.store.snapshot().channels.some(c=>c.deviceId==='d51'&&c.readinessProof),false);assert.equal(f.service.aiCandidates().length,0);assert.ok(f.events.some(e=>e[0]==='stop'&&e[1]==='d51'));
});
for(const change of ['login','human','limited','offline','identity','generation','stoppedRound','otherRound','cancel','busy','staleTask','deadline'])test('late AI cannot make unsafe probe ready: '+change,async t=>{
 const f=await fixture(t);f.fail();await f.service.tick();const b={...f.service.aiCandidates()[0],token:'one'};assert.ok(b.lookupId);await f.service.claimAiReading(b);
 if(change==='offline')f.blocked.add('d51');
 if(change==='identity')f.adapter.readinessIdentity=()=> 'changed';
 if(change==='staleTask')f.adapter.aiEvidence=()=>({...b,jobId:'another'});
 const flags={login:'accountOffline',human:'human',limited:'exhausted',busy:'busy'};if(flags[change])f.obs.set('d51',{[flags[change]]:true});
 await f.store.transact(s=>{let r=s.requests.find(r=>r.lookupId===b.lookupId),c=s.channels.find(c=>c.deviceId==='d51');if(change==='generation')c.generation='changed';if(change==='stoppedRound')s.preparations[0].stopRequestedAt=Date.now();if(change==='otherRound')s.preparations[0].preparationId='new';if(change==='cancel')r.cancelRequested=true;if(change==='deadline')r.executionDeadline=0;});
 assert.equal(await f.service.finishAiReading(b,f.name(b)),false);assert.equal(f.store.snapshot().channels.some(c=>c.readinessProof),false);
});
test('probe reader timeout releases only its phone while another becomes ready; lease restart does not call model twice',async t=>{
 const f=await fixture(t);f.fail();await f.service.tick();let calls=0;const pump=createLookupAiRecovery({service:f.service,timeoutMs:40,loadEvidence:async()=>Buffer.from('fixture'),reader:{enabled:true,read:async()=>{calls++;return new Promise(()=>{});}}});t.after(()=>pump.close());pump.pump();
 const c=f.store.snapshot().channels.find(c=>c.deviceId==='d52');f.obs.set('d52',{ready:true,result:{resultId:c.queryId,status:'succeeded',name:'测试(**乙)'}});await f.service.tick();
 await new Promise(r=>setTimeout(r,100));await f.service.tick();assert.equal(calls,1);assert.equal((await f.service.prepare({clientId:'a',key:'prepare-test-1'})).readyCount,1);assert.equal(f.service.aiCandidates().length,0);
});
test('restart expires original AI lease without duplicate inference and rejects its old result',async t=>{
 const f=await fixture(t);f.fail();await f.service.tick();const b={...f.service.aiCandidates()[0],token:'old'};assert.ok(b.lookupId);await f.service.claimAiReading(b);const restarted=f.make();t.after(()=>restarted.close());assert.equal(restarted.aiCandidates().length,0);f.advance(130001);const next={...restarted.aiCandidates()[0],token:'next'};assert.equal(next.expired,true);await restarted.claimAiReading(next);assert.equal(await restarted.finishAiReading(b,f.name(b)),false);await restarted.finishAiReading(next,{kind:'unconfirmed',reason:'interrupted'});assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===b.lookupId).status,'failed');
});

for(const currentEpoch of [false,true])test('historical login exclusion does not block renewed probe AI; current exclusion stays closed '+currentEpoch,async t=>{
 const f=await fixture(t);await f.store.transact(s=>{const p=s.preparations[0];s.devices.find(d=>d.deviceId==='d51').accountOffline={jobId:'old-login',blockedRounds:[{clientId:'a',preparationId:p.preparationId,epoch:currentEpoch?p.loginEpoch:'older-epoch'}]};});
 f.fail();await f.service.tick();const b={...f.service.aiCandidates()[0],token:'renewed'};
 if(currentEpoch){assert.equal(b.lookupId,undefined);return;}
 assert.ok(b.lookupId);assert.equal(await f.service.claimAiReading(b),true);assert.equal(await f.service.finishAiReading(b,f.name(b)),true);await f.service.tick();
 assert.equal(f.store.snapshot().devices.find(d=>d.deviceId==='d51').accountOffline,undefined);
 assert.equal((await f.service.prepare({clientId:'a',key:'prepare-test-1'})).readyCount,1);
 assert.equal(f.events.filter(e=>e[0]==='query'&&e[1]==='d51').length,1);
});
