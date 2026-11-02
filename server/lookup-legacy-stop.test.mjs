import { WECOM_PREVIEW_KIND } from "./wecom-preview.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
import {createManagedLookupService} from './managed-lookup.mjs';
import {createManagedLookupStore,initialManagedLookupState} from './managed-lookup-store.mjs';
import {confirmedLookupStop} from './lookup-stop-proof.mjs';
import {canDeliverManagedLookupTask,issueScreenGalleryDelivery,acknowledgeScreenGalleryDelivery} from './managed-lookup-delivery.mjs';

// Actual adapter + actual task-result reducer; only task execution/transport is
// synthetic. These redacted shapes do not import or modify production records.
const source=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');
const syncBody=source.match(/^function syncAutomationJobFromWindowsTask\(windowsTask, status, result = \{\}\) \{[\s\S]*?^\}/m)[0];
const sanitizeBody=source.match(/^function sanitizeTaskResult\(input = \{\}, options = \{\}\) \{[\s\S]*?^\}/m)[0];
const cancelBody=source.match(/^function cancelAutomationJob\(job, reason = "cancelled", options = \{\}\) \{[\s\S]*?^\}/m)[0];
const finishBody=source.match(/^function finishLookupSession\(session, status, reason = ""\) \{[\s\S]*?^\}/m)[0];
const sanitize=new Function('cloneJson',sanitizeBody+';return sanitizeTaskResult;')(structuredClone);
const runtime='22222222-2222-4222-8222-222222222222';
function fixture(numbers=[51]){
 const pool=initialManagedLookupState(),now=Date.now(),released=[],calls=[];
 const state={devices:[],windowsAgents:[{agentId:'agent',lookupRuntimeId:runtime,lastSeenAt:new Date(now).toISOString()}],automationSessions:[],automationJobs:[],windowsTasks:[],deviceLocks:[],audit:[]};
 for(const n of numbers){
  const c={deviceId:'phone-'+n,sessionId:'session-'+n,generation:'generation-'+n,clientId:'client',phase:'stopping',requestId:'cancelled-'+n,queryId:'query-'+n,stopRetryCount:2,stopRetryAt:0};
  pool.channels.push(c);pool.devices.push({deviceId:c.deviceId,deviceNumber:n,enabled:true});
  if(n!==154)pool.requests.push({lookupId:c.requestId,clientId:'client',purpose:'readiness_probe',status:'cancelled',completedAt:new Date(now-60000).toISOString()});
  state.devices.push({deviceId:c.deviceId,deviceName:String(n),adb:{agentId:'agent'}});
  state.automationSessions.push({sessionId:c.sessionId,deviceId:c.deviceId,source:'managed-api',clientId:'client',userId:'user',managedLookupGeneration:c.generation,status:'stopping',pendingJobId:'',results:[],lookupStopFailure:{jobId:'old-job-'+n,taskId:'old-task-'+n,code:'lookup_reader_cleanup_unconfirmed'}});
  state.automationJobs.push({jobId:'old-job-'+n,deviceId:c.deviceId,sessionId:c.sessionId,source:'managed-api',clientId:'client',kind:'alipay_name_stop',status:'failed',windowsTaskId:'old-task-'+n});
  state.windowsTasks.push({taskId:'old-task-'+n,deviceId:c.deviceId,agentId:'agent',type:'alipay_name_stop',status:'failed',payload:{automationJobId:'old-job-'+n,automationSessionId:c.sessionId,managedLookup:{protocol:'managed_lookup_v1',generation:c.generation}}});
  state.deviceLocks.push({lockId:'lock-'+n,deviceId:c.deviceId,managedLookupGeneration:c.generation});
 }
 let seq=0;const nowIso=()=>new Date().toISOString(),isTerminalStatus=s=>['succeeded','failed','cancelled','expired'].includes(s);
 const release=s=>{released.push(s.sessionId);state.deviceLocks=state.deviceLocks.filter(l=>l.deviceId!==s.deviceId);};
 const cancel=new Function('WECOM_PREVIEW_KIND','wecomCleanup','state','nowIso','isTerminalStatus','releaseAutomationLock',cancelBody+';return cancelAutomationJob;')(WECOM_PREVIEW_KIND,null,state,nowIso,isTerminalStatus,release);
 const finish=new Function('nowIso','releaseAutomationLock',finishBody+';return finishLookupSession;')(nowIso,release);
 const api={state,online:()=>true,onlineMs:90000,screenActive:()=>false,listed:()=>true,allCooling:()=>false,lockFor:id=>state.deviceLocks.find(x=>x.deviceId===id),
  createJob:input=>{calls.push('create');const j={...input,jobId:'new-job-'+(++seq),status:'queued'};state.automationJobs.push(j);return j;},
  queueTask:(device,j)=>{calls.push('queue');const s=state.automationSessions.find(s=>s.sessionId===j.sessionId),t={taskId:'new-task-'+seq,deviceId:device.deviceId,agentId:'agent',type:j.kind,status:'queued',payload:{automationJobId:j.jobId,automationSessionId:j.sessionId,managedLookup:{protocol:'managed_lookup_v1',generation:s.managedLookupGeneration}}};j.windowsTaskId=t.taskId;state.windowsTasks.push(t);return t;},
  cancelJob:(...args)=>{calls.push('cancel');return cancel(...args);},persist:async()=>{calls.push('persist');}};
 const deps={WECOM_PREVIEW_KIND,wecomCleanup:null,state,isTerminalStatus,sanitizeTaskResult:sanitize,nowIso,repos:{devices:{findById:id=>state.devices.find(d=>d.deviceId===id)}},confirmedLookupStop,finishLookupSession:finish};
 const sync=new Function(...Object.keys(deps),syncBody+';return syncAutomationJobFromWindowsTask;')(...Object.values(deps));
 const adapter=createManagedLookupAdapter(api);
 return {pool,state,api,adapter,sync,released,calls,c:pool.channels[0],session:state.automationSessions[0],oldTask:state.windowsTasks[0]};
}
function tx(){const undo=[],commit=[];return {client:{},onRollback:f=>undo.push(f),onCommit:f=>commit.push(f),rollback:()=>undo.reverse().forEach(f=>f()),commit:()=>commit.forEach(f=>f())};}
function pending(f){const j=f.state.automationJobs[0],t=f.oldTask;j.status=t.status='running';j.kind=t.type='alipay_name_query';f.session.pendingJobId=j.jobId;return {j,t};}

for(const field of ['device','generation','emptyGeneration','client','source','pendingSession','pendingDevice','pendingClient','pendingSource','pendingKind','missingJob','missingTask','taskJob','taskKind','taskSession','taskGeneration','taskDevice'])test('stale stop '+field+' rejects before any cancellation or write',async()=>{
 const f=fixture(),{j,t}=pending(f),c={...f.c};
 if(field==='device')f.session.deviceId='other';
 if(field==='generation')f.session.managedLookupGeneration='new-generation';
 if(field==='emptyGeneration'){delete f.session.managedLookupGeneration;delete c.generation;}
 if(field==='client')f.session.clientId='other';
 if(field==='source')f.session.source='manual';
 if(field==='pendingSession')j.sessionId='other';
 if(field==='pendingDevice')j.deviceId='other';
 if(field==='pendingClient')j.clientId='other';
 if(field==='pendingSource')j.source='manual';
 if(field==='pendingKind')j.kind='xhs_publish';
 if(field==='missingJob')f.state.automationJobs=[];
 if(field==='missingTask')f.state.windowsTasks=[];
 if(field==='taskJob')t.payload.automationJobId='other';
 if(field==='taskKind')t.type='alipay_name_start';
 if(field==='taskSession')t.payload.automationSessionId='other';
 if(field==='taskGeneration')t.payload.managedLookup.generation='other';
 if(field==='taskDevice')t.deviceId='other';
 const before=structuredClone(f.state);
 await assert.rejects(f.adapter.stop(c,tx()),/managed_stop_binding_mismatch/);
 assert.deepEqual(f.state,before);assert.deepEqual(f.calls,[]);
});

test('correct pending binding is cancelled durably before fresh stop can be leased',async()=>{
 const f=fixture(),{j,t}=pending(f),x=tx();
 await f.adapter.stop(f.c,x);const fresh=f.state.windowsTasks.at(-1);
 assert.equal(j.status,'cancelled');assert.equal(t.status,'cancelled');
 assert.equal(canDeliverManagedLookupTask(fresh),false);assert.equal(f.state.deviceLocks.length,1);
 assert.equal(f.session.pendingJobId,fresh.payload.automationJobId);assert.equal(fresh.payload.managedLookup.generation,f.c.generation);
 assert.equal(acknowledgeScreenGalleryDelivery(t,'old-lease').ok,false);
 assert.throws(()=>issueScreenGalleryDelivery(t,{token:'old-lease',lookupRuntimeId:runtime}),/not_queueable/);
 x.commit();assert.equal(canDeliverManagedLookupTask(fresh),true);
});

test('offline stop rejects without cancelling the bound running task',async()=>{
 const f=fixture();pending(f);f.api.online=()=>false;const before=structuredClone(f.state);
 await assert.rejects(f.adapter.stop(f.c,tx()),/managed_stop_requires_online/);
 assert.deepEqual(f.state,before);assert.deepEqual(f.calls,[]);
});

test('four exhausted legacy stops without runtime retry through actual adapter and durable coordinator',async t=>{
 const f=fixture([51,52,54,154]),dir=await fs.mkdtemp(path.join(os.tmpdir(),'lookup-legacy-stop-')),file=path.join(dir,'pool.json');
 let store,service;const persisted=new Set();t.after(async()=>{await store?.close();await fs.rm(dir,{recursive:true,force:true});});
 await fs.writeFile(file,JSON.stringify(f.pool));
 store=await createManagedLookupStore({file,persistLegacy:async()=>{
  for(const task of f.state.windowsTasks.filter(t=>t.status==='queued'&&!persisted.has(t.taskId))){assert.equal(canDeliverManagedLookupTask(task),false,'no lease before commit');persisted.add(task.taskId);}
 }});
 service=createManagedLookupService({store,adapter:f.adapter});
 const originalRequests=structuredClone(f.pool.requests),oldTasks=structuredClone(f.state.windowsTasks);
 for(const c of f.pool.channels){assert.equal(f.adapter.runtimeLoss(c),null);assert.equal(f.adapter.observe(c).stopUnconfirmed,true);}
 await service.tick();
 assert.equal(f.calls.filter(x=>x==='queue').length,4);
 for(const c of f.pool.channels){assert.ok(service.reserved(c.deviceId));assert.equal(f.adapter.observe(c).stopped,undefined);}
 const fresh=f.state.windowsTasks.filter(t=>t.status==='queued');assert.equal(fresh.length,4);
 for(const task of fresh){assert.ok(canDeliverManagedLookupTask(task));issueScreenGalleryDelivery(task,{token:'synthetic-lease',lookupRuntimeId:runtime});assert.equal(acknowledgeScreenGalleryDelivery(task,'synthetic-lease').ok,true);}
 assert.deepEqual(f.state.windowsTasks.slice(0,4),oldTasks,'never backfill old runtime or ACK');
 await store.close();store=await createManagedLookupStore({file});service=createManagedLookupService({store,adapter:f.adapter});
 await service.tick();assert.equal(f.calls.filter(x=>x==='queue').length,4,'restart cannot duplicate pending stops');
 for(const task of oldTasks)f.sync(task,'succeeded',{diagnostic:{lookupStopProof:{version:1,readerCleanupConfirmed:true,taskId:task.taskId,sessionId:task.payload.automationSessionId,generation:task.payload.managedLookup.generation}}});
 assert.equal(f.released.length,0,'old terminal jobs cannot acquire a new proof');
 for(const task of fresh){const c=f.pool.channels.find(c=>c.deviceId===task.deviceId);f.sync(task,'succeeded',{diagnostic:{lookupStopProof:{version:1,readerCleanupConfirmed:true,taskId:task.taskId,sessionId:c.sessionId,generation:c.generation}}});}
 await service.tick();
 assert.equal(f.released.length,4);assert.equal(store.snapshot().channels.length,0);assert.equal(f.state.deviceLocks.length,0);
 assert.deepEqual(store.snapshot().requests,originalRequests,'cancelled probes and missing query are never resurrected');
 assert.ok(f.state.automationJobs.every(j=>j.kind==='alipay_name_stop'),'cleanup creates no query/start occupancy');
});

test('fresh cleanup without matching proof remains reserved',async()=>{
 const f=fixture(),x=tx();await f.adapter.stop(f.c,x);x.commit();const task=f.state.windowsTasks.at(-1);
 f.sync(task,'succeeded',{diagnostic:{lookupStopProof:{version:1,readerCleanupConfirmed:true,taskId:f.oldTask.taskId,sessionId:f.c.sessionId,generation:f.c.generation}}});
 assert.equal(f.released.length,0);assert.equal(f.adapter.observe(f.c).stopUnconfirmed,true);assert.equal(f.state.deviceLocks.length,1);
});

test('failed persistence restores session, pending task and jobs without exposing a stop',async()=>{
 const f=fixture();pending(f);const before=structuredClone(f.state),x=tx();f.api.persist=async()=>{throw new Error('fixture-persist-failed');};
 await assert.rejects(f.adapter.stop(f.c,x),/managed_lookup_persistence_failed/);x.rollback();
 assert.deepEqual(f.state,before);assert.equal(f.released.length,0);
});
