import assert from 'node:assert/strict';
import test from 'node:test';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
import {issueScreenGalleryDelivery,readScreenGalleryDeliveryPayload,acknowledgeScreenGalleryDelivery} from './managed-lookup-delivery.mjs';

function fixture(){
 const c={deviceId:'phone',clientId:'caller',sessionId:'session',generation:'generation',roundStopPreparationId:'round'};
 const session={sessionId:'session',deviceId:'phone',managedLookupGeneration:'generation',status:'querying',pendingJobId:'job',results:[{resultId:'kept',status:'succeeded',name:'kept'}]};
 const job={jobId:'job',sessionId:'session',deviceId:'phone',kind:'alipay_name_query',status:'running',windowsTaskId:'task'};
 const task={taskId:'task',deviceId:'phone',type:'alipay_name_query',status:'queued',payload:{automationJobId:'job',automationSessionId:'session',phoneNumber:'13800000000',managedLookup:{protocol:'managed_lookup_v1',generation:'generation'}}};
 const state={automationSessions:[session],automationJobs:[job],windowsTasks:[task],deviceLocks:[{lockId:'retained',status:'active'}]};
 const undo=[],bundles=[];const tx={client:{isolated:true},onRollback:fn=>undo.push(fn)};
 const adapter=createManagedLookupAdapter({state,persist:async b=>bundles.push(structuredClone(b)),
  cancelJob(j,reason,options){assert.equal(options.releaseLock,false);j.status='cancelled';j.result={errorCode:reason};const t=state.windowsTasks.find(t=>t.taskId===j.windowsTaskId);if(t)t.status='cancelled';}});
 return {state,c,session,job,task,tx,adapter,bundles,rollback:()=>undo.reverse().forEach(fn=>fn())};
}
test('durable offline fence cancels payload and ACK, retains results and physical lock',async()=>{
 const f=fixture();issueScreenGalleryDelivery(f.task,{token:'lease-token'});
 assert.equal(readScreenGalleryDeliveryPayload(f.task,'lease-token').ok,true);await f.adapter.quarantineRoundStop(f.c,f.tx);
 assert.equal(readScreenGalleryDeliveryPayload(f.task,'lease-token').ok,false);assert.equal(acknowledgeScreenGalleryDelivery(f.task,'lease-token').ok,false);
 assert.equal(f.session.status,'stopping');assert.equal(f.session.pendingJobId,'');assert.equal(f.job.status,'cancelled');
 assert.equal(f.state.deviceLocks[0].status,'active');assert.equal(f.session.results[0].name,'kept');assert.equal(f.bundles.length,1);
 assert.equal(f.bundles[0].windowsTasks[0].status,'cancelled');assert.equal(f.bundles[0].automationJobs[0].status,'cancelled');
});
test('fence only touches this session/generation; unrelated work is preserved',async()=>{
 const f=fixture();const foreign={...f.task,taskId:'foreign',payload:{...f.task.payload,automationSessionId:'other',managedLookup:{protocol:'managed_lookup_v1',generation:'other'}}};
 f.state.windowsTasks.push(foreign);const before=structuredClone(foreign);await f.adapter.quarantineRoundStop(f.c,f.tx);assert.deepEqual(foreign,before);
});
test('rollback restores exact session, jobs and task leases after persistence failure',async()=>{
 const f=fixture();issueScreenGalleryDelivery(f.task,{token:'lease-token'});const before=structuredClone(f.state);
 const adapter=createManagedLookupAdapter({state:f.state,persist:async()=>{throw Error('injected SQL failure');},cancelJob:j=>{j.status='cancelled';}});
 await assert.rejects(adapter.quarantineRoundStop(f.c,f.tx),{code:'managed_lookup_persistence_failed'});f.rollback();assert.deepEqual(f.state,before);
});
test('missing or mismatched generation cannot declare a cancellation fence',async()=>{
 for(const change of [f=>f.c.generation='other',f=>f.state.automationSessions=[],f=>f.task.payload.managedLookup.generation='other']){
  const f=fixture();change(f);const before=structuredClone(f.state);await assert.rejects(f.adapter.quarantineRoundStop(f.c,f.tx),/managed_stop_fence_binding/);assert.deepEqual(f.state,before);
 }
});
test('orphan leased and handover-pending tasks are fenced even without an active job',async()=>{
 const f=fixture();f.state.automationJobs=[];f.task.status='human_handover_pending';await f.adapter.quarantineRoundStop(f.c,f.tx);
 assert.equal(f.task.status,'cancelled');assert.equal(f.bundles[0].windowsTasks.length,1);
});

test('business handoff fences only the old attempt with its own reason, without a round stop',async()=>{
 const f=fixture();delete f.c.roundStopPreparationId;f.c.offlineHandoffSince=Date.now()-30000;await f.adapter.quarantineRoundStop(f.c,f.tx);
 assert.equal(f.job.result.errorCode,'lookup_device_offline_reassigned');assert.equal(f.task.result.errorCode,'lookup_device_offline_reassigned');assert.equal(f.state.deviceLocks[0].status,'active');
});
test('offline detection includes stale Agent heartbeat but not screen occupancy or cooling',()=>{
 const state={devices:[{deviceId:'phone',adb:{agentId:'agent'}}],windowsAgents:[{agentId:'agent',lastSeenAt:new Date().toISOString()}]};let online=true;
 const adapter=createManagedLookupAdapter({state,online:()=>online,onlineMs:60000});assert.equal(adapter.isOffline({deviceId:'phone'}),false);
 state.windowsAgents[0].lastSeenAt=new Date(Date.now()-61000).toISOString();assert.equal(adapter.isOffline({deviceId:'phone'}),true);
 state.windowsAgents[0].lastSeenAt=new Date().toISOString();online=false;assert.equal(adapter.isOffline({deviceId:'phone'}),true);
});
