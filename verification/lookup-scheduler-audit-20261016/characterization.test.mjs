import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=process.env.LOOKUP_AUDIT_SOURCE;
if(!root)throw new Error('Set LOOKUP_AUDIT_SOURCE to the verified assembled rc.15 source');
const {createManagedLookupService}=await import(pathToFileURL(path.join(root,'server/managed-lookup.mjs')));
const {initialManagedLookupState}=await import(pathToFileURL(path.join(root,'server/managed-lookup-store.mjs')));
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

// Characterization assertions: passing reproduces current behavior, including gaps.
test('queued work is assigned to newly completed human/probe phone, not prebound',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87]);const ready=await f.twoReady();
 const rows=await Promise.all(Array.from({length:5},(_,i)=>f.submit('audit-dynamic-'+i,'1390000010'+i)));
 await f.service.tick();assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===rows[2].lookupId).attempts.length,0);
 const third=f.store.snapshot().channels.find(c=>!ready.some(x=>x.deviceId===c.deviceId));
 f.obs.set(third.deviceId,{human:true});await f.service.tick();
 assert.equal(await f.service.beforeResume(third.sessionId),true);await f.readyStart(third);await f.service.tick();await f.result(third);
 assert.equal(f.store.snapshot().channels.find(c=>c.deviceId===third.deviceId).requestId,rows[2].lookupId);
});
test('with six enabled devices an unhealthy fifth is replaced by a sixth probe',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138]);await f.prepare();await f.service.tick();
 const cs=f.store.snapshot().channels;for(const c of cs.slice(0,4)){await f.readyStart(c);await f.result(c);}
 f.offline.add(cs[4].deviceId);f.obs.set(cs[4].deviceId,{ready:false,stopped:true,startFailed:true});
 await f.service.tick();assert.ok(f.events.some(e=>e.kind==='start'&&e.device==='d138'));
 const sixth=f.store.snapshot().channels.find(c=>c.deviceId==='d138');await f.readyStart(sixth);await f.result(sixth);
 assert.equal((await f.prepare()).readyCount,5);
});
test('GAP: six idle minutes retain verified proof and skip fresh probe at assignment',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const probes=f.events.filter(e=>e.purpose==='readiness_probe').length;
 f.advance(360000);await f.service.tick();assert.equal((await f.prepare()).ready,true);
 const r=await f.submit();await f.service.tick();assert.equal(f.events.filter(e=>e.purpose==='readiness_probe').length,probes);
 assert.equal(f.events.find(e=>e.id===r.lookupId).options.verified,true);
});
test('GAP: five waiting humans stop dispatch on two healthy idle phones',async()=>{
 const f=fixture();await f.configure();await f.twoReady();
 for(const c of f.store.snapshot().channels.filter(c=>!c.readinessProof))f.obs.set(c.deviceId,{human:true});
 await f.service.tick();
 for(const c of f.store.snapshot().channels.filter(c=>!c.readinessProof))f.obs.set(c.deviceId,{human:true});
 await f.service.tick();assert.equal(f.service.admin().counts.waitingHuman,5);assert.equal((await f.prepare()).ready,true);
 const r=await f.submit();await f.service.tick();assert.equal(f.service.admin().counts.executing,0);
 assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).status,'queued');
});
test('GAP: selection uses last use, without priority for just-restored phone',async()=>{
 const f=fixture();await f.configure([51,52]);await f.prepare();await f.service.tick();let cs=f.store.snapshot().channels;
 for(const c of cs)await f.readyStart(c);await f.result(cs[0]);
 f.obs.set(cs[1].deviceId,{human:true});await f.service.tick();f.advance(60000);await f.result(cs[1]);
 const r=await f.submit();await f.service.tick();assert.equal(f.store.snapshot().channels.find(c=>c.requestId===r.lookupId).deviceId,cs[0].deviceId);
});
