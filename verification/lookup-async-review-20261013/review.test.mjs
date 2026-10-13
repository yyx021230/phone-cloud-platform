// Review-only counterexamples against immutable lookup-async-20261013-rc.1.
// Synthetic state + one bounded loopback HTTP server; never uses ADB/real phones.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createManagedLookupService} from '../../releases/lookup-async-20261013-rc.1/server/managed-lookup.mjs';
import {initialManagedLookupState} from '../../releases/lookup-async-20261013-rc.1/server/managed-lookup-store.mjs';
import {createManagedLookupAdapter} from '../../releases/lookup-async-20261013-rc.1/server/managed-lookup-platform.mjs';
import {OpenNameLookupClient} from '../../releases/lookup-async-20261013-rc.1/sdk/open_name_lookup/node_client.mjs';

function fixture({channels=[],requests=[],observations={}}={}) {
  let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();
  state.config={...state.config,enabled:true,concurrency:2};
  state.grants=[{clientId:'review',enabled:true,consentReference:'synthetic-review-consent'}];
  state.devices=[118,130].map(n=>({deviceId:'d'+n,deviceNumber:n,enabled:true}));
  state.channels=channels;state.requests=requests;
  const events=[];
  const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,clientId)=>state.requests.find(r=>r.lookupId===id&&r.clientId===clientId),close:async()=>{},transact(fn){
    const job=tail.then(async()=>{const next=structuredClone(state),undo=[],commits=[];try{const result=await fn(next,{archived:async()=>null,onRollback:f=>undo.push(f),onCommit:f=>commits.push(f)});state=next;commits.forEach(f=>f());return result;}catch(e){undo.reverse().forEach(f=>f());throw e;}});tail=job.catch(()=>{});return job;
  }};
  let service;
  const adapter={clientValid:()=>true,health:()=>({ready:true}),canStop:()=>true,observe:c=>observations[c.deviceId]||{busy:true},validateDevice:()=>{},
    start:async(c,r)=>{if(service.reserved(c.deviceId))throw Error('device_busy');c.sessionId='s-'+r.lookupId;events.push({kind:'start',lookupId:r.lookupId});},
    query:async(c,r)=>{c.queryId=r.queryId='q-'+r.lookupId;events.push({kind:'query',lookupId:r.lookupId});},
    stop:async c=>events.push({kind:'stop',lookupId:c.requestId})};
  service=createManagedLookupService({store,adapter,now:()=>clock});
  return {store,service,adapter,events,observations,advance:ms=>clock+=ms};
}
const request=(id,status='running')=>({lookupId:id,clientId:'review',status,createdAt:new Date().toISOString(),attempts:[],deadline:Date.now()+1800000,name:''});
const channel=(deviceId,id,phase='querying')=>({deviceId,clientId:'review',sessionId:'s-'+id,requestId:id,queryId:'q-'+id,phase});
function proof(scenario,observed){console.log(JSON.stringify({scenario,observed,physicalQueries:0,productionConnections:0}));}

test('control: different key after121seconds still coalesces in-flight async lookup',async()=>{
 const f=fixture();const a=await f.service.submitAsync({clientId:'review',phoneNumber:'13800000001',key:'review-original'});f.advance(121000);const b=await f.service.submitAsync({clientId:'review',phoneNumber:'13800000001',key:'review-new-key'});assert.equal(a.lookupId,b.lookupId);assert.equal(f.store.snapshot().requests.length,1);
});

test('R1 offline idle device must not roll back the other device completed result',async()=>{
 const f=fixture({channels:[{...channel('d118','old','idle'),requestId:'',idleAt:1},channel('d130','active')],requests:[request('active')]});
 const platform={devices:[{deviceId:'d118'},{deviceId:'d130'}],automationSessions:[{sessionId:'s-old',status:'ready',results:[]},{sessionId:'s-active',status:'ready',results:[{resultId:'q-active',status:'succeeded',name:'测*'}]}],automationJobs:[],windowsTasks:[],deviceLocks:[],audit:[]};
 const actual=createManagedLookupAdapter({state:platform,online:d=>d?.deviceId==='d130'});
 f.adapter.observe=actual.observe;f.adapter.stop=actual.stop;f.adapter.canStop=actual.canStop;
 const error=await f.service.tick().then(()=>null,e=>e.message);proof('R1',{error,otherStatus:f.store.snapshot().requests[0].status});
 assert.equal(error,null,'offline idle stop must not abort whole scheduler transaction');
 assert.equal(f.store.snapshot().requests[0].status,'succeeded');
});

test('R2 failed startup release must not reacquire the published old reservation in same tick',async()=>{
 const first=request('start-failed','preparing');first.attempts=[{deviceId:'d118'}];
 const f=fixture({channels:[{...channel('d118','start-failed','starting'),queryId:''},channel('d130','complete')],requests:[first,request('complete'),request('queued','queued')],observations:{d118:{startFailed:true,stopped:true},d130:{result:{status:'succeeded',name:'测*'}}}});
 const error=await f.service.tick().then(()=>null,e=>e.message);proof('R2',{error,otherStatus:f.store.snapshot().requests[1].status});assert.equal(error,null,'startup release must defer reacquisition until reservation commit');assert.equal(f.store.snapshot().requests[1].status,'succeeded');
});

test('R3 revoked pool grant must stop first query dispatch after account preparation',async()=>{
 const f=fixture({channels:[{...channel('d118','prepared','starting'),queryId:''}],requests:[request('prepared','preparing')],observations:{d118:{ready:true}}});
 await f.service.configure({grants:[{clientId:'review',enabled:false,consentReference:'synthetic-review-consent'}]},'review');await f.service.tick();const queries=f.events.filter(e=>e.kind==='query').length;proof('R3',{queriesAfterGrantRevocation:queries,status:f.store.snapshot().requests[0].status});assert.equal(queries,0,'revoked authorization cannot dispatch a not-yet-started phone query');
});

test('R4 confirmed original result must survive cancel before next coordinator tick',async()=>{
 const f=fixture({channels:[channel('d118','finished')],requests:[request('finished')],observations:{d118:{result:{status:'succeeded',name:'测*'}}}});
 await f.service.cancel('finished','review');await f.service.tick();f.observations.d118={stopped:true};await f.service.tick();const result=await f.service.getAsyncResult('finished','review');proof('R4',{status:result.status,code:result.code,namePreserved:Boolean(result.name)});assert.equal(result.status,'succeeded','confirmed result must be reconciled before replacing it with cancelled');assert.equal(result.name,'测*');
});

test('R4B already received success must be reconciled before the execution budget cancels it',async()=>{
 const r={...request('deadline-result'),mode:'async',executionDeadline:Date.now()+100};
 const f=fixture({channels:[channel('d118','deadline-result')],requests:[r],observations:{d118:{result:{status:'succeeded',name:'测*'}}}});
 f.advance(200);await f.service.tick();f.observations.d118={stopped:true};await f.service.tick();const result=await f.service.getAsyncResult('deadline-result','review');proof('R4B',{status:result.status,code:result.code,namePreserved:Boolean(result.name)});assert.equal(result.status,'succeeded','deadline must not discard an already received authoritative success');
});

async function loopback(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return `http://127.0.0.1:${server.address().port}`;}
test('R5 SDK timeout must cover response body after headers arrive',async t=>{
 const baseUrl=await loopback(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"ok":');setTimeout(()=>res.end('true}'),250);});
 const client=new OpenNameLookupClient({baseUrl,clientId:'synthetic-review',secret:'synthetic-review-signing-secret'});const start=Date.now();let failure;await client.getLookupResult('synthetic-lookup',{requestTimeoutMs:30}).catch(e=>failure=e);proof('R5',{elapsedMs:Date.now()-start,requestedTimeoutMs:30,errorCode:failure?.code||null});assert.equal(failure?.code,'network_error','body read must be aborted at the configured deadline');
});

test('R6 SDK retries truncated accepted response with same business key',async t=>{
 let requests=0;const keys=[];const baseUrl=await loopback(t,(req,res)=>{requests++;keys.push(req.headers['idempotency-key']);res.writeHead(202,{'content-type':'application/json'});if(requests===1){res.write('{"ok":');setTimeout(()=>res.destroy(),10);}else res.end('{"ok":true,"lookupId":"synthetic-lookup","status":"queued","reused":true}');});
 const client=new OpenNameLookupClient({baseUrl,clientId:'synthetic-review',secret:'synthetic-review-signing-secret'});let failure;const result=await client.submitLookup('13800000001',{idempotencyKey:'synthetic-stable-key'}).catch(e=>{failure=e;});proof('R6',{httpRequests:requests,errorName:failure?.name||null,errorCode:failure?.code||null});assert.equal(requests,2,'body transport error must enter same-key network retry');assert.equal(keys[0],keys[1]);assert.equal(result.lookupId,'synthetic-lookup');
});

test('R7 new integration document must recommend async submission instead of the legacy sync path',async()=>{
 const doc=await fs.readFile(new URL('../../releases/lookup-async-20261013-rc.1/OPEN_NAME_LOOKUP_API.md',import.meta.url),'utf8');const legacyRecommendation=doc.includes('新接入优先使用上面的同步接口');proof('R7',{newIntegrationStillRecommendsSync:legacyRecommendation});assert.equal(legacyRecommendation,false,'legacy sync does not provide the new-key in-flight coalescing contract');
});
