import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture({transport=false}={}){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 if(transport)adapter.isOffline=c=>offline.has(c.deviceId);
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

const row=(f,id)=>f.store.snapshot().requests.find(r=>r.lookupId===id);
async function running(){
 const f=fixture();await f.configure([51,52]);await f.service.configure({asyncQueueWaitMs:1000,asyncTaskTtlMs:60000,humanWaitMs:100},'test');await f.twoReady();
 const req=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(c=>c.requestId===req.lookupId);
 return {f,req,c,total:row(f,req.lookupId).executionDeadline};
}
async function issue(f,c,kind){
 if(kind==='limit')f.obs.set(c.deviceId,{ready:true,exhausted:true,result:{resultId:c.queryId,status:'limit_reached'}});
 if(kind==='login')f.obs.set(c.deviceId,{accountOffline:{jobId:'login-terminal',account:'fixture-account',accountSource:'verified'},ready:false});
 if(kind==='executor')f.obs.set(c.deviceId,{recovery:true,recoveryFailure:{jobId:'terminal-worker',domain:'device',reason:'local_lookup_result_unconfirmed:ocr_reader_timeout'}});
 if(kind==='human'){f.obs.set(c.deviceId,{human:true});await f.service.tick();f.advance(101);}
 await f.service.tick();
}
for(const kind of ['limit','login','executor','human'])test(kind+' handoff after initial queue deadline preserves original total budget and ID',async()=>{
 const {f,req,c,total}=await running();f.advance(1001);await issue(f,c,kind);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1,'no replay before stop ACK');
 await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===req.lookupId);
 assert.ok(next,'query must remain eligible after its first-queue deadline');assert.notEqual(next.deviceId,c.deviceId);
 assert.equal(row(f,req.lookupId).deadline,total);assert.equal(row(f,req.lookupId).executionDeadline,total);
 assert.equal((await f.submit('new-key-after-handoff')).lookupId,req.lookupId);
 f.obs.set(c.deviceId,{stopped:true,result:{resultId:c.queryId,status:'succeeded',name:'旧'}});await f.service.tick();
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'processing');
 await f.result(next,'续');assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).name,'续');
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,2);
});
test('initially unassigned query still expires at its original queue deadline',async()=>{
 const {f}=await running();const other=await f.submit('second-running-id','13900000001');await f.service.tick();const waiting=await f.submit('third-stays-queued','13900000002');
 f.advance(1001);await f.service.tick();assert.equal(row(f,waiting.lookupId).code,'lookup_queue_timeout');
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===waiting.lookupId).length,0);
 assert.equal((await f.service.getAsyncResult(other.lookupId,'a')).status,'processing');
});
test('original total deadline while waiting for stop ACK never starts another phone',async()=>{
 const {f,req,c,total}=await running();const stop=f.adapter.stop;f.adapter.stop=async x=>{f.events.push({kind:'stop',device:x.deviceId});f.obs.set(x.deviceId,{unknown:true});};
 f.advance(1001);await issue(f,c,'limit');f.advance(59000);f.obs.set(c.deviceId,{stopped:true});await f.service.tick();
 assert.equal(row(f,req.lookupId).executionDeadline,total);assert.equal(row(f,req.lookupId).code,'lookup_processing_timeout');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);f.adapter.stop=stop;
});
test('explicit round stop during handoff wins over requeue',async()=>{
 const {f,req,c}=await running();f.advance(1001);await issue(f,c,'limit');
 await f.service.stopRound({clientId:'a',key:'stop-reroute-round',preparationId:f.store.snapshot().preparations[0].preparationId});await f.service.tick();
 assert.equal((await f.service.getAsyncResult(req.lookupId,'a')).status,'failed');assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);
});

test('handoff waiting for replacement survives restart but never extends total deadline',async()=>{
 const {f,req,c,total}=await running();for(const x of f.store.snapshot().channels)if(x.deviceId!==c.deviceId)f.offline.add(x.deviceId);
 f.advance(1001);await issue(f,c,'login');await f.service.tick();assert.equal(row(f,req.lookupId).status,'queued');
 f.restart();assert.equal(row(f,req.lookupId).deadline,total);assert.equal((await f.submit('retry-after-restart')).lookupId,req.lookupId);
 f.advance(59000);await f.service.tick();assert.equal(row(f,req.lookupId).code,'lookup_processing_timeout');assert.equal(row(f,req.lookupId).executionDeadline,total);
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===req.lookupId).length,1);
});
