import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './lookup-reader-capacity.test.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';

test('exhausted stop resumes paced cleanup, never releases before proof, then accepts next lookup',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(c=>c.requestId===r.lookupId);
 let stops=0;f.adapter.stop=async c=>{stops++;f.obs.set(c.deviceId,{stopUnconfirmed:true});};
 await f.store.transact(s=>{const x=s.channels.find(x=>x.sessionId===c.sessionId);x.phase='stopping';x.stopRetryCount=2;x.stopRetryAt=0;x.rerouteAfterStop=true;});
 f.obs.set(c.deviceId,{stopUnconfirmed:true});await f.service.tick();
 assert.equal(stops,1,'old retry2 must not permanently suppress real cleanup');
 assert.ok(f.service.reserved(c.deviceId));assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
 f.advance(59999);await f.service.tick();assert.equal(stops,1);f.advance(1);await f.service.tick();assert.equal(stops,2);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();
 const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);
 await f.result(next,'恢复姓名');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'恢复姓名');
 const later=await f.submit('next-business','13900000001');await f.service.tick();
 const lc=f.store.snapshot().channels.find(x=>x.requestId===later.lookupId);assert.ok(lc);await f.result(lc,'下一条');
 assert.equal((await f.service.getAsyncResult(later.lookupId,'a')).name,'下一条');
});

test('late cleanup retries pause for live manual control and do not burst after long gap',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const c=f.store.snapshot().channels[0];let stops=0,screen=true;
 f.adapter.screenActive=()=>screen;f.adapter.stop=async x=>{if(x.deviceId===c.deviceId)stops++;};
 await f.store.transact(s=>{const x=s.channels[0];x.stopRetryCount=2;x.stopRetryAt=0;x.phase='stopping';});
 f.obs.set(c.deviceId,{stopUnconfirmed:true});await f.service.tick();assert.equal(stops,0);
 screen=false;await f.service.tick();assert.equal(stops,1);f.advance(3600000);await f.service.tick();assert.equal(stops,2);
 for(let i=0;i<10;i++)await f.service.tick();assert.equal(stops,2);
});

function runtimeFixture(){
 const old='11111111-1111-4111-8111-111111111111',current='22222222-2222-4222-8222-222222222222';
 const now=Date.now();const c={sessionId:'s',generation:'g',deviceId:'d',queryId:'q',clientId:'a'};
 const session={sessionId:'s',deviceId:'d',managedLookupGeneration:'g',pendingJobId:'j',status:'querying',results:[]};
 const job={jobId:'j',sessionId:'s',deviceId:'d',windowsTaskId:'t',source:'managed-api',clientId:'a',kind:'alipay_name_query',resultId:'q',status:'running'};
 const task={taskId:'t',deviceId:'d',agentId:'agent',type:'alipay_name_query',status:'running',delivery:{lookupRuntimeId:old,ackedAt:new Date(now-60000).toISOString()},payload:{automationSessionId:'s',managedLookup:{generation:'g'}}};
 const agent={agentId:'agent',lookupRuntimeId:current,lastSeenAt:new Date(now).toISOString(),lookupExecutionReport:{runtimeId:current,receivedAt:now,activeTaskIds:[]}};
 const state={automationSessions:[session],automationJobs:[job],windowsTasks:[task],devices:[{deviceId:'d',adb:{agentId:'agent'}}],windowsAgents:[agent]};
 return {c,session,task,agent,job,old,current,adapter:createManagedLookupAdapter({state,online:()=>true,onlineMs:90000})};
}
test('runtime loss requires exact acknowledged old task and fresh authenticated new runtime report',()=>{
 const f=runtimeFixture();assert.equal(f.adapter.runtimeLoss?.(f.c)?.taskId,'t');
 for(const mutate of [x=>x.task.delivery.lookupRuntimeId=x.current,x=>delete x.task.delivery.lookupRuntimeId,x=>x.task.delivery.ackedAt='',x=>x.task.payload.managedLookup.generation='other',x=>x.agent.lookupExecutionReport.activeTaskIds=['t'],x=>x.agent.lookupExecutionReport.receivedAt-=16000,x=>x.job.resultId='other',x=>x.task.agentId='other']){
  const x=runtimeFixture();mutate(x);assert.equal(x.adapter.runtimeLoss?.(x.c)??null,null);
 }
});
test('new runtime preserves original lookup through real stop barrier; late known result wins',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);
 let lost=true,stops=0;f.adapter.runtimeLoss=x=>lost&&x.sessionId===c.sessionId?{taskId:'old-task',runtimeId:'new-runtime'}:null;
 f.adapter.stop=async x=>{stops++;lost=false;f.obs.set(x.deviceId,{busy:true});};
 await f.service.tick();assert.equal(stops,0);f.advance(29999);await f.service.tick();assert.equal(stops,0);
 f.advance(1);await f.service.tick();assert.equal(stops,1);assert.ok(f.service.reserved(c.deviceId));
 assert.equal((await f.submit('client-timeout-retry')).lookupId,r.lookupId);
 assert.equal(f.events.filter(x=>x.kind==='query'&&x.id===r.lookupId).length,1);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);await f.result(next,'接续');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'接续');
});
test('result received during runtime grace is preserved and does not trigger duplicate query',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);
 f.adapter.runtimeLoss=x=>x.sessionId===c.sessionId?{taskId:'old-task',runtimeId:'new-runtime'}:null;
 await f.service.tick();f.advance(30000);await f.result(c,'已返回');
 assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'已返回');
 assert.equal(f.events.filter(x=>x.kind==='query'&&x.id===r.lookupId).length,1);
});

test('runtime observation rejects truncated and malformed lists rather than declaring lost work',async()=>{
 const {normalizeLookupExecutionReport:normalize}=await import('./lookup-reader-admission.mjs');
 const runtimeId='11111111-1111-4111-8111-111111111111';
 const report={version:1,runtimeId,limit:2,pinnedSerials:[],receivedAt:Date.now()};
 assert.deepEqual(normalize(report,''),{runtimeId,receivedAt:report.receivedAt,activeTaskIds:[]});
 for(const value of [Array(33).fill(runtimeId).join(','),runtimeId+','+runtimeId,runtimeId+',','%zz','invalid'])assert.equal(normalize(report,value),null);
 assert.equal(normalize(null,''),null);
 assert.deepEqual(normalize(report,runtimeId).activeTaskIds,[runtimeId]);
});

test('acknowledged managed work is never blindly requeued by generic Agent reconnect',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm');
 const source=await fs.readFile(new URL('./index.mjs',import.meta.url),'utf8');
 const start=source.indexOf('function recoverStalledTasks('),end=source.indexOf('\nfunction expireWindowsTasks(',start);
 const {isManagedLookupTask}=await import('./managed-lookup-delivery.mjs');
 for(const offlineFirst of [false,true]){
  const {task}=runtimeFixture();task.payload.managedLookup.protocol='managed_lookup_v1';task.status=offlineFirst?'running':'stalled';
  const undelivered=structuredClone(task);undelivered.taskId='unacknowledged';undelivered.delivery.ackedAt='';
  const other=structuredClone(task);other.taskId='unrelated';other.type='xhs';
  let online=!offlineFirst;
  const state={windowsAgents:[{agentId:'agent'}],windowsTasks:[task,undelivered,other]};
  const context=vm.createContext({state,Date,Set,isManagedLookupTask,isWindowsAgentOnline:()=>online,toTime:Date.parse,
    WINDOWS_TASK_TTL_MS:3600000,nowIso:()=>new Date().toISOString(),newId:()=>crypto.randomUUID(),
    syncXhsTaskFromWindowsTask:()=>{},syncAutomationJobFromWindowsTask:()=>{}});
  vm.runInContext(source.slice(start,end),context);
  if(offlineFirst){context.recoverStalledTasks();assert.equal(task.status,'stalled');online=true;}
  context.recoverStalledTasks();assert.equal(task.status,'stalled');assert.ok(task.delivery.ackedAt);
  assert.equal(undelivered.status,'queued');assert.equal(other.status,'queued');
 }
 const f=runtimeFixture();f.task.status='stalled';assert.equal(f.adapter.runtimeLoss(f.c)?.taskId,'t');
 f.task.status='cancelled';assert.equal(f.adapter.runtimeLoss(f.c),null);
});

for(const mode of ['deadline','cancel','round'])test('unconfirmed cleanup ends '+mode+' logically, never releases the phone',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);let fences=0;
 f.adapter.fenceCleanupWait=async()=>{fences++;};f.adapter.screenActive=()=>true;
 f.adapter.stop=async()=>{};
 await f.store.transact(s=>{const x=s.channels.find(x=>x.sessionId===c.sessionId);x.phase='stopping';x.stopRetryCount=2;x.stopRetryAt=Date.now()+999999999;});
 f.obs.set(c.deviceId,{stopUnconfirmed:true});
 if(mode==='deadline')f.advance(7200000);
 else if(mode==='cancel')await f.service.cancel(r.lookupId,'test');
 else{const p=await f.prepare();await f.service.stopRound({clientId:'a',preparationId:p.preparationId,key:'cleanup-round-stop'});for(const x of f.store.snapshot().channels)if(x.deviceId!==c.deviceId)f.obs.set(x.deviceId,{stopped:true});}
 await f.service.tick();
 const saved=f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId);
 assert.equal(saved.status,mode==='deadline'?'expired':'cancelled');assert.equal(fences,1);
 assert.ok(f.service.reserved(c.deviceId));assert.equal(f.service.reserved(c.deviceId).phase,'stopping');
 assert.ok(f.service.reserved(c.deviceId).stopCleanupAttentionAt);
 assert.equal(f.events.filter(x=>x.kind==='query'&&x.id===r.lookupId).length,1);
 if(mode==='round')assert.equal(f.store.snapshot().roundStops[0].status,'stopped');
 f.restart();await f.service.tick();assert.equal(fences,1);assert.ok(f.service.reserved(c.deviceId));
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();assert.equal(f.service.reserved(c.deviceId),undefined);
});

test('cleanup cancellation persistence failure keeps original request and reservation',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);f.obs.set(c.deviceId,{stopUnconfirmed:true});
 f.adapter.fenceCleanupWait=async()=>{throw Error('synthetic fence persistence failed');};
 await f.service.cancel(r.lookupId,'test');await assert.rejects(f.service.tick());
 assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).status,'cancelling');assert.ok(f.service.reserved(c.deviceId));
});

test('already received exact result wins even during cleanup backoff and deadline',async()=>{
 const f=fixture();await f.configure([51,52]);await f.twoReady();const r=await f.submit();await f.service.tick();
 const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);
 await f.store.transact(s=>{const x=s.channels.find(x=>x.sessionId===c.sessionId);x.phase='stopping';x.stopRetryCount=2;x.stopRetryAt=Date.now()+999999999;});
 f.advance(7200000);let fences=0;f.adapter.fenceCleanupWait=async()=>{fences++;};
 f.obs.set(c.deviceId,{stopUnconfirmed:true,result:{resultId:c.queryId,status:'succeeded',name:'received'}});
 await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'received');
 assert.equal(fences,0);assert.ok(f.service.reserved(c.deviceId));
});
