import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {confirmedLookupStop,hasConfirmedLookupStop} from './lookup-stop-proof.mjs';
import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
const source=fs.readFileSync(new URL('./index.mjs',import.meta.url),'utf8');
const body=source.match(/^function syncAutomationJobFromWindowsTask\(windowsTask, status, result = \{\}\) \{[\s\S]*?^\}/m)[0];
const sanitizeBody=source.match(/^function sanitizeTaskResult\(input = \{\}, options = \{\}\) \{[\s\S]*?^\}/m)[0];
const sanitize=new Function('cloneJson',sanitizeBody+';return sanitizeTaskResult;')(structuredClone);
function fixture(){
 const session={sessionId:'session',deviceId:'phone',managedLookupGeneration:'g',pendingJobId:'stop-job',status:'stopping',results:[{status:'cancelling'}]};
 const job={jobId:'stop-job',sessionId:'session',deviceId:'phone',kind:'alipay_name_stop',status:'running',windowsTaskId:'stop-task'};
 const task={taskId:'stop-task',deviceId:'phone',type:'alipay_name_stop',payload:{automationJobId:'stop-job',automationSessionId:'session',managedLookup:{generation:'g'}}};
 const proof={version:1,readerCleanupConfirmed:true,taskId:'stop-task',sessionId:'session',generation:'g'};
 const state={automationSessions:[session],automationJobs:[job],windowsTasks:[task]};const released=[];
 const deps={state,isTerminalStatus:s=>['succeeded','failed','cancelled','expired'].includes(s),sanitizeTaskResult:sanitize,nowIso:()=>new Date().toISOString(),repos:{devices:{findById:()=>({})}},confirmedLookupStop,finishLookupSession:(s,status)=>{s.status=status;released.push(s.sessionId);}};
 const sync=new Function(...Object.keys(deps),body+';return syncAutomationJobFromWindowsTask;')(...Object.values(deps));
 return {session,job,task,proof,state,released,sync,c:{sessionId:'session',deviceId:'phone',generation:'g'}};
}
for(const status of ['failed','cancelled','succeeded'])test('stop '+status+' without proof keeps reservation and cancellation pending',()=>{const f=fixture();f.sync(f.task,status,{errorCode:'lookup_reader_cleanup_unconfirmed'});assert.equal(f.session.status,'stopping');assert.equal(f.session.results[0].status,'cancelling');assert.equal(f.released.length,0);assert.equal(f.session.lookupStopFailure.code,'lookup_reader_cleanup_unconfirmed');const o=createManagedLookupAdapter({state:f.state}).observe(f.c);assert.equal(o.stopUnconfirmed,true);assert.notEqual(o.stopped,true);});
test('only successful matching stop proof survives sanitize and releases exact session',()=>{const f=fixture();f.sync(f.task,'succeeded',{diagnostic:{lookupStopProof:f.proof}});assert.equal(f.session.status,'ended');assert.equal(f.session.results[0].status,'cancelled');assert.deepEqual(f.released,['session']);assert.equal(hasConfirmedLookupStop(f.session,f.c),true);assert.equal(createManagedLookupAdapter({state:f.state}).observe(f.c).stopped,true);});
for(const field of ['taskId','sessionId','generation','readerCleanupConfirmed','version'])test('wrong stop proof '+field+' cannot release',()=>{const f=fixture();f.proof[field]='wrong';f.sync(f.task,'succeeded',{diagnostic:{lookupStopProof:f.proof}});assert.equal(f.released.length,0);assert.equal(f.session.status,'stopping');});
for(const change of ['pendingJob','generation','session','device','task'])test('late stop binding '+change+' cannot alter next task or confirmation',()=>{const f=fixture();if(change==='pendingJob')f.session.pendingJobId='new-job';if(change==='generation')f.task.payload.managedLookup.generation='old';if(change==='session')f.task.payload.automationSessionId='old';if(change==='device')f.task.deviceId='other';if(change==='task')f.task.taskId='other';const before=structuredClone(f.session);f.sync(f.task,'succeeded',{diagnostic:{lookupStopProof:f.proof}});assert.deepEqual(f.session,before);assert.equal(f.released.length,0);});
test('failed/cancelled status cannot be promoted by a success proof',()=>{for(const status of ['failed','cancelled']){const f=fixture();f.sync(f.task,status,{diagnostic:{lookupStopProof:f.proof}});assert.equal(f.released.length,0);}});
test('legacy terminal state alone is not a physical stop ACK',()=>{for(const status of ['ended','failed','expired']){const f=fixture();f.session.status=status;f.session.pendingJobId='';f.state.automationJobs=[];const o=createManagedLookupAdapter({state:f.state}).observe(f.c);assert.notEqual(o.stopped,true);}});
test('unknown stopped proof cannot release a replacement generation',()=>{const f=fixture();f.session.lookupStopConfirmation=f.proof;assert.equal(hasConfirmedLookupStop(f.session,{...f.c,generation:'new'}),false);});

test('actual failed managed preparation retains lock until a separate cleanup task confirms',()=>{
 const code=source.match(/^function finishLookupSession\(session, status, reason = ""\) \{[\s\S]*?^\}/m)[0];
 const released=[];const finish=new Function('nowIso','releaseAutomationLock',code+';return finishLookupSession;')(()=>new Date().toISOString(),s=>released.push(s.sessionId));
 const managed={sessionId:'managed',managedLookupGeneration:'g',pendingJobId:'prepare'};
 finish(managed,'failed','reader_exited');assert.equal(managed.status,'failed');assert.deepEqual(released,[]);
 finish({sessionId:'legacy'},'failed','reader_exited');assert.deepEqual(released,['legacy']);
});
