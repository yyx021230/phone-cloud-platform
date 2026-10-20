import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const base=process.env.LOOKUP_AUDIT_ASSEMBLY;if(!base)throw Error('Set LOOKUP_AUDIT_ASSEMBLY to the hash-verified local candidate assembly');
const {createManagedLookupService}=await import(pathToFileURL(path.join(base,'server/managed-lookup.mjs')));
const {initialManagedLookupState}=await import(pathToFileURL(path.join(base,'server/managed-lookup-store.mjs')));
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

test('audit: three human probes plus replacements leave eight proven idle reservations',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138,152,164]);await f.prepare();await f.service.tick();
 const original=f.store.snapshot().channels;assert.equal(original.length,5);
 for(const c of original)await f.readyStart(c);
 for(const c of original.slice(0,3)){f.obs.set(c.deviceId,{human:true});await f.service.tick();}
 assert.equal(f.store.snapshot().channels.length,8);
 const replacements=f.store.snapshot().channels.filter(c=>!original.some(o=>o.deviceId===c.deviceId));
 for(const c of replacements)await f.readyStart(c);
 for(const c of [...original.slice(3),...replacements,...original.slice(0,3)])await f.result(c);
 assert.equal((await f.prepare()).readyCount,8);assert.equal(f.store.snapshot().channels.filter(c=>c.phase==='idle').length,8);
 f.advance(121000);await f.service.tick();assert.equal(f.store.snapshot().channels.length,8);assert.equal(f.events.filter(e=>e.kind==='stop').length,0);
 const jobs=await Promise.all(Array.from({length:8},(_,i)=>f.submit('audit-business-'+i,'1390000000'+i)));await f.service.tick();
 assert.equal(f.service.admin().counts.executing,5);assert.equal(f.store.snapshot().requests.filter(r=>jobs.some(j=>j.lookupId===r.lookupId)&&r.status==='queued').length,3);
 console.log(JSON.stringify({audit:true,initialChannels:5,humanBlocked:3,standbysOpened:3,readyAfterRecovery:8,reservedIdleAfter121s:8,stops:0,businessSubmitted:8,businessExecuting:5,businessQueued:3,productionConnections:0}));
});
