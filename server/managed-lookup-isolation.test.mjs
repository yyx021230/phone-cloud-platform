import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createManagedLookupService} from './managed-lookup.mjs';
import {createManagedLookupStore} from './managed-lookup-store.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';

const request=(id,status='running')=>({lookupId:id,clientId:'fixture',idempotencyKey:'key-'+id,phoneNumber:'13800000001',fingerprint:'synthetic-'+id,mode:'async',status,createdAt:new Date().toISOString(),deadline:Date.now()+1800000,executionDeadline:Date.now()+3600000,attempts:[],name:''});
const channel=(n,id,phase='querying')=>({deviceId:'d'+n,deviceNumber:n,clientId:'fixture',generation:'gen-'+n,sessionId:'s-'+id,requestId:id,queryId:'q-'+id,phase});
async function fixture(t,{channels=[],requests=[],numbers=[118,130],concurrency=2}={}){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-isolation-'));
  const persisted=await createManagedLookupStore({file:path.join(temp,'state.json')});
  await persisted.transact(s=>{s.config.enabled=true;s.config.concurrency=concurrency;s.devices=numbers.map(n=>({deviceId:'d'+n,deviceNumber:n,enabled:true}));s.grants=[{clientId:'fixture',enabled:true,consentReference:'synthetic-consent'}];s.channels=channels;s.requests=requests;});
  const commits=[],events=[],observations={},offline=new Set();
  let failCommit=false;
  const store={...persisted,transact:operation=>persisted.transact(async(s,tx)=>{
    const result=await operation(s,tx);
    if(failCommit){failCommit=false;throw Error('synthetic storage commit failure');}
    tx.onCommit(()=>commits.push(persisted.snapshot()));return result;
  })};
  const record=(event,tx)=>{events.push(event);tx.onRollback(()=>events.splice(events.indexOf(event),1));};
  let service;
  const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>observations[c.deviceId]||{busy:true},
    start:async(c,r,tx)=>{assert.equal(service.reserved(c.deviceId),undefined);c.sessionId='s-'+r.lookupId;record({kind:'start',deviceId:c.deviceId,id:r.lookupId},tx);},
    query:async(c,r,tx)=>{c.queryId=r.queryId='q-'+r.lookupId;record({kind:'query',deviceId:c.deviceId,id:r.lookupId},tx);},
    stop:async(c,tx)=>record({kind:'stop',deviceId:c.deviceId},tx)};
  service=createManagedLookupService({store,adapter});
  t.after(async()=>{await service.close();await fs.rm(temp,{recursive:true,force:true});});
  return {store,service,adapter,commits,events,observations,offline,failNextCommit:()=>{failCommit=true;}};
}

test('offline idle118 retains its reservation while130 returns its name',async t=>{
  const f=await fixture(t,{channels:[{...channel(118,'old','idle'),requestId:'',idleAt:1},channel(130,'done')],requests:[request('done')]});
  const actual=createManagedLookupAdapter({state:{devices:[{deviceId:'d118'},{deviceId:'d130'}],automationSessions:[{sessionId:'s-old',status:'ready',results:[]},{sessionId:'s-done',status:'ready',results:[{resultId:'q-done',status:'succeeded',name:'测*'}]}],automationJobs:[],windowsTasks:[],deviceLocks:[],audit:[]},online:d=>d?.deviceId==='d130'});
  Object.assign(f.adapter,{observe:actual.observe,canStop:actual.canStop,stop:actual.stop});
  await f.service.tick();assert.equal((await f.service.getAsyncResult('done','fixture')).name,'测*');assert.ok(f.service.reserved('d118'));assert.equal(f.events.length,0);
});

for(const order of ['fault-first','result-first'])test(`device adapter failure does not undo another result: ${order}`,async t=>{
  const faulty={...channel(118,'idle','idle'),requestId:'',idleAt:1},done=channel(130,'done');
  const f=await fixture(t,{channels:order==='fault-first'?[faulty,done]:[done,faulty],requests:[request('done')]});
  f.observations.d118={ready:true};f.observations.d130={result:{status:'succeeded',name:'测*'}};
  f.adapter.stop=async()=>{throw Error('synthetic device error');};
  await assert.rejects(f.service.tick());
  assert.equal((await f.service.getAsyncResult('done','fixture')).name,'测*');assert.equal(f.service.reserved('d118').phase,'idle');
});

test('a completed name is readable before an unrelated stop has returned',async t=>{
  const f=await fixture(t,{channels:[channel(130,'done'),{...channel(118,'idle','idle'),requestId:'',idleAt:1}],requests:[request('done')]});
  f.observations.d130={result:{status:'succeeded',name:'测*'}};f.observations.d118={ready:true};
  let unblock,entered;const gate=new Promise(r=>unblock=r),started=new Promise(r=>entered=r);
  f.adapter.stop=async()=>{entered();await gate;throw Error('synthetic device error');};
  const tick=f.service.tick();const rejected=assert.rejects(tick);
  try{await started;assert.equal((await f.service.getAsyncResult('done','fixture')).status,'succeeded');}finally{unblock();await rejected;}
});

test('five completed phones commit five independently visible results',async t=>{
  const numbers=[118,130,161,162,142];
  const f=await fixture(t,{numbers,concurrency:5,channels:numbers.map(n=>channel(n,'r'+n)),requests:numbers.map(n=>request('r'+n))});
  for(const n of numbers)f.observations['d'+n]={result:{status:'succeeded',name:'测*'}};
  await f.service.tick();const seen=f.commits.map(s=>s.requests.filter(r=>r.status==='succeeded').length);
  assert.deepEqual(seen,[1,2,3,4,5]);
});

test('unchanged busy phones do not multiply durable writes every scheduler poll',async t=>{
  const f=await fixture(t,{channels:[channel(118,'r118'),channel(130,'r130')],requests:[request('r118'),request('r130')]});
  await f.service.tick();await f.service.tick();assert.equal(f.commits.length,0);assert.equal(f.events.length,0);
});

test('failed admission is rolled back locally and other phones still receive work',async t=>{
  const numbers=[118,130,161,162,142,74];
  const f=await fixture(t,{numbers,concurrency:5,requests:numbers.map(n=>request('queued'+n,'queued'))});
  const start=f.adapter.start;f.adapter.start=async(c,r,tx)=>{await start(c,r,tx);if(c.deviceId==='d118')throw Error('synthetic start error');};
  await assert.rejects(f.service.tick());
  assert.equal(f.events.length,5);assert.ok(f.events.every(e=>e.deviceId!=='d118'));assert.equal(f.service.admin().counts.executing,5);assert.equal(f.service.reserved('d118'),undefined);assert.equal(new Set(f.events.map(e=>e.id)).size,5);
});

test('a later persistence failure preserves prior committed results and blocks new dispatch',async t=>{
  const f=await fixture(t,{channels:[channel(118,'first'),channel(130,'second')],requests:[request('first'),request('second'),request('queued','queued')]});
  f.adapter.observe=c=>{if(c.deviceId==='d130')f.failNextCommit();return {result:{status:'succeeded',name:'测*'}};};
  await assert.rejects(f.service.tick(),/synthetic storage commit failure/);
  assert.equal((await f.service.getAsyncResult('first','fixture')).status,'succeeded');assert.equal((await f.service.getAsyncResult('second','fixture')).status,'processing');assert.equal(f.events.length,0);
});

test('human wait on118 keeps its original task while130 commits and continues the queue',async t=>{
  const f=await fixture(t,{channels:[channel(118,'human'),channel(130,'done')],requests:[request('human'),request('done'),request('queued','queued')]});
  f.observations.d118={human:true};f.observations.d130={result:{status:'succeeded',name:'测*'}};
  await f.service.tick();assert.equal((await f.service.getAsyncResult('done','fixture')).name,'测*');assert.equal(f.service.reserved('d118').requestId,'human');assert.equal(f.service.reserved('d118').phase,'human');assert.deepEqual(f.events.map(e=>e.deviceId),['d130']);
});

test('adapter persistence failures halt admission instead of being treated as a bad phone',async t=>{
  const f=await fixture(t,{requests:[request('first','queued'),request('second','queued')]});
  f.adapter.start=async()=>{throw Object.assign(Error('managed_lookup_persistence_failed'),{code:'managed_lookup_persistence_failed'});};
  await assert.rejects(f.service.tick(),{code:'managed_lookup_persistence_failed'});
  assert.equal(f.commits.length,0);assert.equal(f.store.snapshot().channels.length,0);assert.equal(f.events.length,0);
});

test('a fenced owner fails closed even when all phone observations are unchanged',async t=>{
  const f=await fixture(t,{channels:[channel(118,'busy')],requests:[request('busy')]});
  f.store.isFenced=()=>true;
  await assert.rejects(f.service.tick(),/managed_lookup_storage_fenced/);assert.equal(f.commits.length,0);assert.equal(f.events.length,0);
});

test('the real platform adapter identifies SQL persistence errors and rolls back its task',async()=>{
  const state={devices:[{deviceId:'d118'}],automationJobs:[],automationSessions:[],windowsTasks:[],deviceLocks:[],audit:[]};
  let n=0;const undo=[];const adapter=createManagedLookupAdapter({state,userFor:()=>({userId:'fixture'}),
    createSession:input=>{const s={...input,sessionId:'s'+ ++n};state.automationSessions.push(s);return s;},
    createJob:input=>{const j={...input,jobId:'j'+ ++n};state.automationJobs.push(j);return j;},
    acquireLock:()=>{const l={lockId:'l'+ ++n};state.deviceLocks.push(l);return l;},
    queueTask:()=>{const task={taskId:'t'+ ++n,payload:{}};state.windowsTasks.push(task);return task;},
    persist:async()=>{throw Error('synthetic SQL failure');}});
  await assert.rejects(adapter.start({deviceId:'d118',clientId:'fixture',generation:'synthetic-generation'},{},{client:{},onRollback:fn=>undo.push(fn),onCommit:()=>{}}),{code:'managed_lookup_persistence_failed'});
  for(const rollback of undo.reverse())rollback();assert.equal(state.windowsTasks.length,0);assert.equal(state.automationSessions.length,0);assert.equal(state.deviceLocks.length,0);
});
