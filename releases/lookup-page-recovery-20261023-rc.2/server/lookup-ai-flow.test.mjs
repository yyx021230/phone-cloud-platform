import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createManagedLookupService} from './managed-lookup.mjs';import {createManagedLookupStore} from './managed-lookup-store.mjs';import {PREPARED_PROTOCOL} from './lookup-readiness.mjs';import {createLookupAiRecovery} from './lookup-ai-recovery.mjs';import {publicAsyncLookup} from './managed-lookup-async.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,n=1){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ai-flow-'));const store=await createManagedLookupStore({file:path.join(dir,'state.json')});let clock=Date.now();
 const events=[],observations=new Map(),unhealthy=new Set(),evidence={jobId:'job',taskId:'task',evidenceId:'evidence',evidenceSha256:'a'.repeat(64),mimeType:'image/png'};
 await store.transact(s=>{s.config.enabled=true;s.grants=[{clientId:'a',enabled:true}];s.requests=Array.from({length:n},(_,i)=>({lookupId:'r'+i,clientId:'a',phoneNumber:'19900000000',queryId:'q'+i,resultProtocol:PREPARED_PROTOCOL,mode:'async',status:'needs_recovery',executionDeadline:clock+3600000,createdAt:new Date(clock).toISOString(),attempts:[],automaticRecoveries:[{deviceId:'d'+i,domain:'page'}]}));s.channels=s.requests.map((r,i)=>({requestId:r.lookupId,queryId:r.queryId,phase:'recovery',pageCompatibilityRequired:true,sessionId:'s'+i,generation:'g'+i,deviceId:'d'+i,clientId:'a',queryIdentity:'identity'}));});
 const adapter={clientValid:()=>true,health:id=>({ready:!unhealthy.has(id)}),canStop:c=>!unhealthy.has(c.deviceId),readinessIdentity:()=> 'identity',observe:c=>observations.get(c.deviceId)||{recovery:true,recoveryFailure:{jobId:'job',domain:'page',identity:'identity'}},aiEvidence:()=>({...evidence}),recordAiResult:async(c,r,tx)=>{const old=observations.get(c.deviceId);tx.onRollback(()=>old?observations.set(c.deviceId,old):observations.delete(c.deviceId));observations.set(c.deviceId,{ready:true,result:{resultId:c.queryId,status:r.status,name:r.name}});},stop:async c=>events.push(c.deviceId)};
 let service=createManagedLookupService({store,adapter,now:()=>clock,aiEnabled:true});t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true});});
 return {store,adapter,service,events,evidence,observations,unhealthy,advance:n=>clock+=n,restart:()=>createManagedLookupService({store,adapter,now:()=>clock,aiEnabled:true}),binding:()=>({...service.aiCandidates()[0],token:'token'}),name:b=>({kind:'name',name:'测试(*甲)',matchedPhone:'19900000000',evidenceSha256:b.evidenceSha256})};
}
for(const named of [true,false])test('original ID final '+(named?'name':'empty')+' before cleanup; reservation waits for ACK',async t=>{
 const f=await fixture(t),b=f.binding();assert.ok(await f.service.claimAiReading(b));assert.ok(await f.service.finishAiReading(b,named?f.name(b):{kind:'unconfirmed'}));
 const r=f.store.snapshot().requests[0],p=publicAsyncLookup(r);assert.deepEqual(Object.keys(p).sort(),['lookupId','name','ok','status']);assert.equal(p.name,named?'测试(*甲)':'');assert.equal(p.status,'completed');assert.equal(r.queryId,b.queryId);assert.ok(f.service.reserved(b.deviceId));
 await f.service.tick();assert.deepEqual(f.events,[b.deviceId]);assert.equal(f.service.reserved(b.deviceId).phase,'stopping');
 f.observations.set(b.deviceId,{stopped:true});await f.service.tick();assert.equal(f.service.reserved(b.deviceId),undefined);assert.equal(publicAsyncLookup(f.store.snapshot().requests[0]).name,p.name);
 assert.equal(await f.service.finishAiReading(b,f.name(b)),false);
});
for(const mutation of ['probe','running','completed','cancel','roundstop','offline','wrongquery','wrongidentity','busy','human','login','limited','newgeneration','noauthorized'])test('AI excluded or late result rejected: '+mutation,async t=>{
 const f=await fixture(t),b=f.binding();await f.service.claimAiReading(b);
 await f.store.transact(s=>{const r=s.requests[0],c=s.channels[0];if(mutation==='probe')r.purpose='readiness_probe';if(mutation==='running')r.status='running';if(mutation==='completed'){r.status='succeeded';r.name='原姓名';}if(mutation==='cancel')r.cancelRequested=true;if(mutation==='roundstop')c.roundStopPreparationId='p';if(mutation==='wrongquery')r.queryId='other';if(mutation==='newgeneration')c.generation='other';if(mutation==='noauthorized')s.grants=[];});
 if(mutation==='offline')f.unhealthy.add('d0');if(mutation==='wrongidentity')f.adapter.readinessIdentity=()=> 'other';
 for(const [key,flag]of Object.entries({busy:'busy',human:'human',login:'accountOffline',limited:'exhausted'}))if(mutation===key)f.observations.set('d0',{[flag]:true});
 assert.equal(await f.service.finishAiReading(b,f.name(b)),false);assert.equal(f.events.length,0);
});
test('lease survives process restart, expires once and settles empty, old token rejected',async t=>{
 const f=await fixture(t),b=f.binding();await f.service.claimAiReading(b);const service=f.restart();assert.equal(service.aiCandidates().length,0);f.advance(130001);const next={...service.aiCandidates()[0],token:'new'};assert.equal(next.expired,true);await service.claimAiReading(next);assert.equal(await service.finishAiReading(b,f.name(b)),false);await service.finishAiReading(next,{kind:'unconfirmed',reason:'interrupted'});assert.equal(publicAsyncLookup(f.store.snapshot().requests[0]).name,'');assert.equal(service.aiCandidates().length,0);
});
test('missing screenshot has bounded 10-second upload grace and then empty fallback',async t=>{
 const f=await fixture(t);Object.assign(f.evidence,{evidenceId:'',evidenceSha256:'',completedMs:Date.now()});assert.equal(f.service.aiCandidates().length,0);f.advance(11000);const b=f.binding();await f.service.claimAiReading(b);await f.service.finishAiReading(b,{kind:'unconfirmed'});assert.equal(publicAsyncLookup(f.store.snapshot().requests[0]).name,'');
});
test('five independent network slots; stalled reader hard-times out without blocking other results or tick',async t=>{
 const f=await fixture(t,5);let calls=0;const pump=createLookupAiRecovery({service:f.service,timeoutMs:2000,loadEvidence:async()=>Buffer.from('fixture'),reader:{enabled:true,read:async()=>{calls++;if(calls===1)return new Promise(()=>{});return {kind:'unconfirmed'};}}});t.after(()=>pump.close());pump.pump();pump.pump();for(let i=0;i<100&&f.store.snapshot().requests.filter(r=>r.status==='not_found').length<4;i++)await sleep(10);assert.equal(calls,5);assert.equal(f.store.snapshot().requests.filter(r=>r.status==='not_found').length,4);await f.service.tick();for(let i=0;i<250&&pump.active();i++)await sleep(10);assert.equal(f.store.snapshot().requests.filter(r=>r.status==='not_found').length,5);assert.equal(pump.active(),0);
});
test('persistence failure keeps both managed result and session state; lease recovers',async t=>{
 const f=await fixture(t),b=f.binding(),original=f.adapter.recordAiResult;await f.service.claimAiReading(b);f.adapter.recordAiResult=async(...args)=>{await original(...args);throw Error('synthetic persist error');};await assert.rejects(f.service.finishAiReading(b,f.name(b)));assert.equal(f.store.snapshot().requests[0].status,'needs_recovery');assert.equal(f.observations.size,0);f.adapter.recordAiResult=original;f.advance(130001);const retry={...f.service.aiCandidates()[0],token:'next'};await f.service.claimAiReading(retry);await f.service.finishAiReading(retry,{kind:'unconfirmed'});assert.equal(f.store.snapshot().requests[0].status,'not_found');
});
test('shutdown discards delayed model output and preserves restart lease',async t=>{const f=await fixture(t);let resolve;const pump=createLookupAiRecovery({service:f.service,timeoutMs:100,loadEvidence:async()=>Buffer.from('fixture'),reader:{enabled:true,read:()=>new Promise(r=>resolve=r)}});pump.pump();await sleep(20);pump.close();resolve({kind:'unconfirmed'});await sleep(10);assert.equal(f.store.snapshot().requests[0].status,'needs_recovery');});

for(const mode of ['exact','missing','generic','identity','disabled','running'])test('first terminal proven result enters AI without a second phone task: '+mode,async t=>{
 const f=await fixture(t);await f.store.transact(s=>{const r=s.requests[0],c=s.channels[0];r.automaticRecoveries=[];r.status='running';c.phase='querying';delete c.pageCompatibilityRequired;if(mode==='disabled')s.config.enabled=false;});
 f.evidence.directResult=mode!=='generic';if(mode==='missing')f.evidence.evidenceId='';
 if(mode==='identity')f.adapter.readinessIdentity=()=> 'changed';if(mode==='running')f.observations.set('d0',{busy:true});
 let dispatched=0;f.adapter.query=async()=>{dispatched++;};await f.service.tick();
 if(mode==='exact'){assert.equal(dispatched,0);assert.equal(f.service.aiCandidates().length,1);assert.equal(f.store.snapshot().requests[0].queryId,'q0');}
 else assert.equal(f.service.aiCandidates().length,0);
});
test('AI diagnostics remain internal and original result contract unchanged',async t=>{const f=await fixture(t),b=f.binding();await f.service.claimAiReading(b);await f.service.finishAiReading(b,{kind:'unconfirmed',rejectionCode:'card_actions_or_compact_boundary'});const r=f.store.snapshot().requests[0];assert.equal(r.aiVision.readKind,'unconfirmed');assert.equal(r.aiVision.rejectionCode,'card_actions_or_compact_boundary');assert.deepEqual(Object.keys(publicAsyncLookup(r)).sort(),['lookupId','name','ok','status']);});
