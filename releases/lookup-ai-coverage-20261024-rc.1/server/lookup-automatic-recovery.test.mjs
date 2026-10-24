import test from 'node:test';import assert from 'node:assert/strict';
import {createManagedLookupService} from './managed-lookup.mjs';import {initialManagedLookupState} from './managed-lookup-store.mjs';
function fixture(){
 let state=initialManagedLookupState(),clock=Date.now(),tail=Promise.resolve();const events=[],obs=new Map(),epochs=new Map(),offline=new Set();
 const store={snapshot:()=>structuredClone(state),isFenced:()=>false,readRequest:async(id,client)=>structuredClone(state.requests.find(r=>r.lookupId===id&&r.clientId===client)),close:async()=>{},transact(fn){const work=tail.then(async()=>{const next=structuredClone(state),commits=[];const out=await fn(next,{archived:async()=>null,onRollback:()=>{},onCommit:fn=>commits.push(fn)});state=next;commits.forEach(fn=>fn());return out;});tail=work.catch(()=>{});return work;}};
 const adapter={clientValid:()=>true,validateDevice:()=>{},health:id=>({ready:!offline.has(id)}),canStop:c=>!offline.has(c.deviceId),observe:c=>obs.get(c.deviceId)||{busy:true},readinessIdentity:c=>c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1'),start:async(c,r)=>{c.sessionId='s-'+c.generation;events.push({kind:'start',device:c.deviceId,id:r.lookupId});obs.set(c.deviceId,{busy:true});},query:async(c,r,tx,options)=>{if(!options?.recovery)c.queryIdentity=c.sessionId+':'+(epochs.get(c.deviceId)||'account-1:agent-1');r.queryId=c.queryId='q-'+r.lookupId+'-'+c.generation;events.push({kind:'query',device:c.deviceId,id:r.lookupId,purpose:r.purpose,options});obs.set(c.deviceId,{busy:true});},stop:async c=>{events.push({kind:'stop',device:c.deviceId});obs.set(c.deviceId,{stopped:true,ready:false});}};
 let service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});
 const configure=(numbers=[51,52,54,55,87,138,152])=>service.configure({enabled:true,devices:numbers.map(n=>({deviceNumber:n,deviceId:'d'+n,enabled:true})),grants:[{clientId:'a',enabled:true,consentReference:'fixture-allowed'}]},'test');
 const prepare=(key='prepare-key-1')=>service.prepare({clientId:'a',key});
 const readyStart=async c=>{obs.set(c.deviceId,{ready:true});await service.tick();};
 const result=async(c,name='名',status='succeeded')=>{obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId||store.snapshot().channels.find(x=>x.deviceId===c.deviceId).queryId,status,name}});await service.tick();};
 const twoReady=async()=>{await prepare();await service.tick();let cs=store.snapshot().channels.slice(0,2);for(const c of cs)await readyStart(c);for(const c of cs)await result(c);return cs;};
 return {get service(){return service;},store,adapter,events,obs,epochs,offline,configure,prepare,readyStart,result,twoReady,advance:n=>clock+=n,restart(){service=createManagedLookupService({store,adapter,now:()=>clock,probePhone:'13800000000'});},submit:(key='business-key-1',phoneNumber='13900000000')=>service.submitAsync({clientId:'a',key,phoneNumber})};
}

import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
const failure=(c,id)=>({recovery:true,ready:true,result:{resultId:c.queryId,status:'needs_recovery'},recoveryFailure:{jobId:id,identity:c.sessionId+':account-1:agent-1'}});
async function running(f){await f.configure([51,52,54]);await f.twoReady();const r=await f.submit();await f.service.tick();return {r,c:f.store.snapshot().channels.find(c=>c.requestId===r.lookupId)};}
test('terminal ordinary failure automatically resumes original query once; new partner key and other phone are independent',async()=>{
 const f=fixture(),{r,c}=await running(f);const other=await f.submit('second-business','13900000001');await f.service.tick();const oc=f.store.snapshot().channels.find(c=>c.requestId===other.lookupId);
 f.obs.set(c.deviceId,failure(c,'failed-1'));await f.service.tick();const q=f.events.filter(e=>e.id===r.lookupId&&e.kind==='query');assert.equal(q.length,2);assert.equal(q[1].options.automaticRecovery,true);assert.equal(q[1].options.verified,true);assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).queryId,c.queryId);
 assert.equal((await f.submit('new-partner-request')).lookupId,r.lookupId);await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);
 await f.result(oc);assert.equal((await f.service.getAsyncResult(other.lookupId,'a')).status,'completed');await f.result(c);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'completed');
});
test('second terminal failure waits for stop ACK then transfers original ID to another ready physical phone',async()=>{
 const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,failure(c,'failure-one'));await f.service.tick();
 f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};
 f.obs.set(c.deviceId,failure(c,'failure-two'));await f.service.tick();await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'stopping');
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);assert.deepEqual(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).recoveryExcludedDevices,[c.deviceId]);await f.result(next,'转');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'转');
});
for(const observation of [{unknown:true},{busy:true},{human:true}])test('uncertain or human execution never enters automatic ordinary retry '+JSON.stringify(observation),async()=>{
 const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,{...failure(c,'old'),...observation});await f.service.tick();await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
});
test('recovery marker without terminal task proof is not replayed',async()=>{const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,{recovery:true});await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);});
test('changed account identity bypasses local resume and stops before handoff',async()=>{const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,{...failure(c,'failed'),recoveryFailure:{jobId:'failed',identity:'different-account'}});await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);assert.ok(f.events.some(e=>e.kind==='stop'&&e.device===c.deviceId));await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.notEqual(next.deviceId,c.deviceId);});
test('recovery budget survives restart and cancellation cannot turn into a handoff',async()=>{const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,failure(c,'first'));await f.service.tick();f.restart();f.obs.set(c.deviceId,failure(c,'second'));await f.service.tick();await f.service.cancel(r.lookupId,'test');await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'failed');});
test('three failing physical phones end with explicit failure after bounded attempts, never fake empty name',async()=>{
 const f=fixture(),{r,c}=await running(f);const third=f.store.snapshot().channels.find(x=>x.deviceId!=='d51'&&x.deviceId!=='d52');await f.readyStart(third);await f.result(third);
 for(let i=0;i<3;i++){const current=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(current);f.obs.set(current.deviceId,failure(current,'first-'+i));await f.service.tick();f.obs.set(current.deviceId,failure(current,'second-'+i));await f.service.tick();await f.service.tick();}
 const result=await f.service.getAsyncResult(r.lookupId,'a');assert.equal(result.status,'failed');assert.equal(result.code,'lookup_recovery_exhausted');assert.equal('name' in result,false);const row=f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId);assert.equal(row.automaticRecoveries.length,3);assert.equal(row.recoveryExcludedDevices.length,3);assert.equal(row.attempts.length,3);
});
test('received name wins over racing recovery failure and is never resubmitted',async()=>{const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,{...failure(c,'failed'),result:{resultId:c.queryId,status:'succeeded',name:'已得'}});await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'已得');assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);});
test('busy screen, disabled pool and revoked grant never auto-dispatch',async()=>{
 for(const mode of ['screen','disabled','revoked']){const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,failure(c,'failed'));if(mode==='screen')f.offline.add(c.deviceId);else await f.store.transact(s=>{if(mode==='disabled')s.config.enabled=false;else s.grants[0].enabled=false;});await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);}
});
test('adapter requires matching failed query and failed transport task; current account identity is preserved',()=>{
 const job={jobId:'j',resultId:'q',sessionId:'s',deviceId:'d',kind:'alipay_name_query',status:'failed',windowsTaskId:'t',createdAt:'2026-10-16T01:00:00Z'},task={taskId:'t',status:'failed'};
 const session={sessionId:'s',deviceId:'d',status:'ready',currentAccount:'138******01',accountIdentityVerified:true,results:[{resultId:'q',status:'needs_recovery'}]};
 const state={automationJobs:[job],automationSessions:[session],windowsTasks:[task],devices:[{deviceId:'d',adb:{agentId:'a'}}],windowsAgents:[{agentId:'a',lookupRuntimeId:'runtime'}]};const a=createManagedLookupAdapter({state,online:()=>true});const c={sessionId:'s',deviceId:'d',queryId:'q',generation:'g'};
 assert.equal(a.observe(c).recoveryFailure.jobId,'j');assert.equal(a.observe(c).recoveryFailure.identity,a.readinessIdentity(c));task.status='stalled';assert.equal(a.observe(c).recoveryFailure,undefined);task.status='failed';job.resultId='other';assert.equal(a.observe(c).recoveryFailure,undefined);job.resultId='q';job.kind='alipay_name_start';assert.equal(a.observe(c).recoveryFailure,undefined);
});
test('automatic recovery payload selects query_resume, keeps original result and skips intervening probe',async()=>{
 const session={sessionId:'s',deviceId:'d',userId:'u',status:'ready',currentAccount:'138******01',results:[]},state={automationJobs:[],automationSessions:[session],windowsTasks:[],deviceLocks:[],audit:[],devices:[{deviceId:'d'}]};let input;
 const api={state,recovery:()=>({phase:'query',resultId:'original-query'}),createJob:x=>{input=x;const job={...x,jobId:'new-job'};state.automationJobs.push(job);return job;},result:()=>({resultId:'original-query'}),queueTask:()=>{const t={taskId:'new-task'};state.windowsTasks.push(t);return t;}};
 const a=createManagedLookupAdapter(api),tx={onRollback:()=>{},onCommit:()=>{}},c={sessionId:'s',deviceId:'d',clientId:'a'},r={lookupId:'original-lookup',queryId:'original-query',phoneNumber:'13900000000'};
 await a.query(c,r,tx,{recovery:true,automaticRecovery:true,prepared:true,probePhone:'13800000000',verified:true});assert.equal(input.resultId,'original-query');assert.equal(input.resumeAfterHumanVerification,true);assert.equal(input.restartAfterHumanVerification,false);assert.equal(state.automationJobs[0].preparedLookup.verifiedAccount,session.currentAccount);
});
test('automatic recovery waits behind five active slots and resumes when one is free',async()=>{
 const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,failure(c,'failed'));
 await f.store.transact(s=>{s.channels=s.channels.filter(x=>x.deviceId===c.deviceId);for(let i=0;i<5;i++)s.channels.push({deviceId:'busy-'+i,generation:'busy-'+i,sessionId:'busy-'+i,phase:'querying',clientId:'a',requestId:''});});
 await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
 await f.store.transact(s=>{s.channels=s.channels.filter(x=>x.deviceId!=='busy-0');});await f.service.tick();assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);assert.equal(f.service.admin().counts.executing,5);
});
for(const reason of ['local_lookup_result_unconfirmed:ocr_reader_timeout','local_lookup_result_unconfirmed:observation_budget_exhausted'])test('exhausted visual reader hands original query off without another full-minute read: '+reason,async()=>{
 const f=fixture(),{r,c}=await running(f);f.obs.set(c.deviceId,{...failure(c,'reader-failed'),recoveryFailure:{...failure(c,'reader-failed').recoveryFailure,reason}});await f.service.tick();
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);assert.ok(f.events.some(e=>e.kind==='stop'&&e.device===c.deviceId));
 const d=f.store.snapshot().devices.find(d=>d.deviceId===c.deviceId);const at=Date.parse(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).createdAt);assert.ok(d.quarantineUntil>=at+300000);
 await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);await f.result(next,'续');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'续');
 f.advance(29999);await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='start'&&e.device===c.deviceId).length,1);
});
test('adapter exposes only whitelisted bounded visual reasons from matching terminal evidence',()=>{
 const job={jobId:'j',resultId:'q',sessionId:'s',deviceId:'d',kind:'alipay_name_query',status:'failed',windowsTaskId:'t',createdAt:'2026-10-16T01:00:00Z',result:{diagnostic:{runnerReason:'local_lookup_result_unconfirmed:ocr_reader_timeout'}}};
 const state={automationJobs:[job],automationSessions:[{sessionId:'s',deviceId:'d',status:'ready',currentAccount:'fixture',accountIdentityVerified:true,results:[{resultId:'q',status:'needs_recovery'}]}],windowsTasks:[{taskId:'t',status:'failed'}],devices:[{deviceId:'d',adb:{agentId:'a'}}],windowsAgents:[{agentId:'a',lookupRuntimeId:'runtime'}]};
 const a=createManagedLookupAdapter({state,online:()=>true}),c={sessionId:'s',deviceId:'d',queryId:'q'};assert.equal(a.observe(c).recoveryFailure.reason,job.result.diagnostic.runnerReason);
 job.result.diagnostic.runnerReason='private upstream details';assert.equal(a.observe(c).recoveryFailure.reason,'');
});
test('20 submissions survive three exhausted readers while healthy phones drain queue and replacements fill five',async()=>{
 const f=fixture();await f.configure([51,52,54,55,87,138,152,188]);await f.prepare();await f.service.tick();
 for(const c of f.store.snapshot().channels)await f.readyStart(c);
 for(const c of f.store.snapshot().channels)await f.result(c);
 const requests=await Promise.all(Array.from({length:20},(_,i)=>f.submit('reader-batch-'+i,'13900000'+String(i).padStart(3,'0'))));
 const failed=new Set();let maximum=0;
 for(let tick=0;tick<100;tick++){
  await f.service.tick();maximum=Math.max(maximum,f.service.admin().counts.executing);assert.ok(maximum<=5);
  const s=f.store.snapshot();if(requests.every(r=>s.requests.find(x=>x.lookupId===r.lookupId).status==='succeeded')&&s.channels.filter(c=>c.readinessProof&&c.phase==='idle').length===5)break;
  for(const c of s.channels){const r=s.requests.find(r=>r.lookupId===c.requestId);
   if(c.phase==='starting')f.obs.set(c.deviceId,{ready:true});
   else if(c.phase==='querying'&&r){
    if(r.purpose!=='readiness_probe'&&failed.size<3&&!failed.has(r.lookupId)){failed.add(r.lookupId);f.obs.set(c.deviceId,{...failure(c,'exhausted-'+r.lookupId),recoveryFailure:{...failure(c,'x').recoveryFailure,reason:'local_lookup_result_unconfirmed:observation_budget_exhausted'}});}
    else f.obs.set(c.deviceId,{ready:true,result:{resultId:c.queryId,status:'succeeded',name:'测'}});
   }
  }
  f.advance(1000);
 }
 assert.equal(failed.size,3);assert.equal(maximum,5);
 for(const r of requests)assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'completed');
 const queries=f.events.filter(e=>e.kind==='query'&&requests.some(r=>r.lookupId===e.id));assert.equal(queries.length,23);assert.equal(new Set(queries.map(e=>e.id+':'+e.device)).size,23);
 assert.equal(f.store.snapshot().channels.filter(c=>c.readinessProof&&c.phase==='idle').length,5);
});

import {lookupHumanRecoveryUnresolved} from './automation-center.mjs';
const exhaustedWorkerJob=()=>({kind:'alipay_name_query',status:'failed',resumeAfterHumanVerification:false,result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:'poco_query_page_recovery_failed: synthetic worker exited during verify_worker_adb_transport'}}});
test('ordinary page recovery exhausted worker failure reaches recovery classification without a human-resume flag',()=>{
 const j=exhaustedWorkerJob();assert.equal(lookupHumanRecoveryUnresolved(j,'failed'),true);
 for(const status of ['running','stalled','succeeded','cancelled'])assert.equal(lookupHumanRecoveryUnresolved(j,status),false);
 assert.equal(lookupHumanRecoveryUnresolved(j,'failed',{limitReached:true}),false);
 for(const kind of ['alipay_name_start','alipay_name_switch','xhs_publish'])assert.equal(lookupHumanRecoveryUnresolved({...j,kind},'failed'),false);
 for(const reason of ['poco_query_page_recovery_failed_other: exit','prefix poco_query_page_recovery_failed: exit','worker_exit',''])assert.equal(lookupHumanRecoveryUnresolved({...j,result:{...j.result,diagnostic:{runnerReason:reason}}},'failed'),false);
 for(const errorCode of ['alipay_login_required','alipay_human_verification_required','other_error'])assert.equal(lookupHumanRecoveryUnresolved({...j,result:{...j.result,errorCode}},'failed'),false);
});
test('real failure shape flows through classifier and adapter with a bounded recovery reason',()=>{
 const job={...exhaustedWorkerJob(),jobId:'q',resultId:'',sessionId:'s',deviceId:'d',windowsTaskId:'t',createdAt:'2026-10-21T02:07:17Z'};
 const task={taskId:'t',status:'failed'},session={sessionId:'s',deviceId:'d',status:'ready',results:[{resultId:'q',status:lookupHumanRecoveryUnresolved(job,'failed')?'needs_recovery':'failed'}]};
 const state={automationJobs:[job],automationSessions:[session],windowsTasks:[task],devices:[],windowsAgents:[]};
 const a=createManagedLookupAdapter({state,online:()=>true}),c={sessionId:'s',deviceId:'d',queryId:'q'};
 assert.equal(a.observe(c).recoveryFailure?.reason,'poco_query_page_recovery_failed');
 for(const status of ['running','stalled','expired','succeeded']){task.status=status;assert.equal(a.observe(c).recoveryFailure,undefined);}task.status='failed';
 job.resultId='another-query';assert.equal(a.observe(c).recoveryFailure,undefined);job.resultId='';
 session.pendingJobId='q';assert.equal(a.observe(c).busy,true);assert.equal(a.observe(c).recoveryFailure,undefined);delete session.pendingJobId;
 session.results[0].status='needs_human_verification';assert.equal(a.observe(c).human,true);assert.equal(a.observe(c).recoveryFailure,undefined);
});
const workerFailure=c=>({...failure(c,'exited-worker'),recoveryFailure:{...failure(c,'exited-worker').recoveryFailure,reason:'poco_query_page_recovery_failed'}});
test('exhausted worker stops without local replay; other phone runs and new key keeps original ID through ACK and late result',async()=>{
 const f=fixture(),{r,c}=await running(f);const other=await f.submit('worker-independent','13900000001');await f.service.tick();const oc=f.store.snapshot().channels.find(x=>x.requestId===other.lookupId);
 f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};
 f.obs.set(c.deviceId,workerFailure(c));await f.service.tick();
 assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'stopping');
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
 await f.result(oc,'另');assert.equal((await f.service.getAsyncResult(other.lookupId,'a')).name,'另');
 f.advance(121000);assert.equal((await f.submit('worker-timeout-new-key')).lookupId,r.lookupId);await f.service.tick();
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1,'must wait for stop ACK');
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);
 await f.result(next,'接');const completed=await f.service.getAsyncResult(r.lookupId,'a');assert.equal(completed.name,'接');
 f.obs.set(c.deviceId,{result:{resultId:c.queryId,status:'succeeded',name:'旧'},stopped:true});await f.service.tick();assert.deepEqual(await f.service.getAsyncResult(r.lookupId,'a'),completed);
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);
});
test('worker handoff cancelled while awaiting stop ACK never resubmits',async()=>{
 const f=fixture(),{r,c}=await running(f);f.adapter.stop=async c=>f.obs.set(c.deviceId,{busy:true});f.obs.set(c.deviceId,workerFailure(c));await f.service.tick();
 await f.service.cancel(r.lookupId,'test');f.obs.set(c.deviceId,{stopped:true});await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'failed');assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
});
test('three exhausted workers terminate with bounded explicit failure, never empty-name success',async()=>{
 const f=fixture(),{r}=await running(f);const third=f.store.snapshot().channels.find(x=>x.deviceId==='d54');await f.readyStart(third);await f.result(third);
 for(let i=0;i<3;i++){const c=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(c);f.obs.set(c.deviceId,workerFailure(c));await f.service.tick();await f.service.tick();}
 const out=await f.service.getAsyncResult(r.lookupId,'a');assert.equal(out.status,'failed');assert.equal(out.code,'lookup_recovery_exhausted');assert.equal('name' in out,false);assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,3);
});

import {lookupFailureDomain} from './lookup-failure-domain.mjs';
test('missing UI and unconfirmed result are page faults; transport requires explicit evidence',()=>{
 const job=reason=>({result:{errorCode:'alipay_lookup_failed',diagnostic:{runnerReason:reason}}});
 for(const reason of ['poco_query_page_recovery_failed:element_not_found','local_lookup_result_unconfirmed:observation_budget_exhausted','local_lookup_result_unconfirmed:visual_card_not_proven','local_lookup_result_unconfirmed:ocr_reader_timeout','unknown'])assert.equal(lookupFailureDomain(job(reason)),'page');
 for(const reason of ['device offline','HTTPConnectionPool(host=local): Read timed out','verify_worker_adb_transport'])assert.equal(lookupFailureDomain(job(reason)),'device');
 for(const code of ['alipay_human_verification_required','alipay_no_available_account','alipay_login_required'])assert.equal(lookupFailureDomain({result:{errorCode:code}}),'');
});
test('page failure reads original input once, keeps original ID and phone, never cascades to spare phones',async()=>{
 const f=fixture(),{r,c}=await running(f),other=await f.submit('page-independent','13900000001');await f.service.tick();const oc=f.store.snapshot().channels.find(x=>x.requestId===other.lookupId);
 const pageFailure=id=>({...failure(c,id),recoveryFailure:{...failure(c,id).recoveryFailure,domain:'page',reason:'local_lookup_result_unconfirmed:observation_budget_exhausted'}});
 f.obs.set(c.deviceId,pageFailure('page-one'));await f.service.tick();
 const qs=f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId);assert.equal(qs.length,2);assert.equal(qs[1].options.observationOnly,true);assert.equal(qs[1].device,c.deviceId);
 f.obs.set(c.deviceId,pageFailure('page-two'));for(let i=0;i<10;i++)await f.service.tick();
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,2);assert.equal(f.events.filter(e=>e.kind==='stop'&&e.device===c.deviceId).length,0);
 const retained=f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId);assert.equal(retained.code,'lookup_page_compatibility_required');assert.equal(retained.status,'needs_recovery');assert.equal(retained.attempts.length,1);
 f.advance(121000);assert.equal((await f.submit('page-new-key')).lookupId,r.lookupId);await f.result(oc);assert.equal((await f.service.getAsyncResult(other.lookupId,'a')).status,'completed');
 await f.service.cancel(r.lookupId,'test');await f.service.tick();await f.service.tick();assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'failed');
});
test('known page recovered on original phone completes normally after same-phone observation',async()=>{
 const f=fixture(),{r,c}=await running(f);const o=failure(c,'page');o.recoveryFailure.domain='page';f.obs.set(c.deviceId,o);await f.service.tick();await f.result(c,'');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).status,'completed');assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).attempts.length,1);
});

test('page recovery on readiness probe keeps original phone without another probe or input',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];await f.readyStart(c);const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId),r=f.store.snapshot().requests.find(x=>x.lookupId===current.requestId);const o=failure(current,'probe-page');o.recoveryFailure.domain='page';f.obs.set(c.deviceId,o);await f.service.tick();const queries=f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId);assert.equal(queries.length,2);assert.equal(queries[1].options.observationOnly,true);assert.equal(queries[1].options.verified,true);await f.result(current);assert.ok(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).readinessProof);
});

test('a probe page still unknown after one observation releases its slot without quarantining hardware',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];await f.readyStart(c);
 const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);
 for(const id of ['page-first','page-second']){f.obs.set(c.deviceId,{...failure(current,id),recoveryFailure:{...failure(current,id).recoveryFailure,domain:'page'}});await f.service.tick();}
 assert.equal(f.store.snapshot().requests.find(r=>r.lookupId===current.requestId).code,'lookup_probe_page_unsupported');
 assert.ok(f.events.some(e=>e.kind==='stop'&&e.device===c.deviceId));assert.notEqual(f.store.snapshot().devices[0].lookupUnavailable,true);
 assert.equal(f.store.snapshot().devices[0].prepareFailureCount,0);await f.service.tick();assert.ok(!f.store.snapshot().channels.some(x=>x.deviceId===c.deviceId));
});

test('terminal executor failure without resumable session keeps original ID and waits for stop ACK',async()=>{
 const f=fixture(),{r,c}=await running(f);f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};
 f.obs.set(c.deviceId,{recovery:true,recoveryFailure:{jobId:'killed',identity:c.queryIdentity||'identity',domain:'execution',canResume:false}});
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);assert.equal(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).phase,'stopping');
 await f.service.tick();assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId).length,1);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.notEqual(next.deviceId,c.deviceId);await f.result(next,'recovered');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'recovered');
});
test('input state loss gets one ordinary same-phone resume, then bounded same-ID handoff',async()=>{
 const f=fixture(),{r,c}=await running(f);const lost=id=>({...failure(c,id),recoveryFailure:{...failure(c,id).recoveryFailure,domain:'state',canResume:true}});
 f.obs.set(c.deviceId,lost('first'));await f.service.tick();const retry=f.events.filter(e=>e.kind==='query'&&e.id===r.lookupId)[1];assert.ok(retry);assert.notEqual(retry.options.observationOnly,true);
 f.obs.set(c.deviceId,lost('second'));await f.service.tick();await f.service.tick();const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.notEqual(next.deviceId,c.deviceId);await f.result(next,'same-id');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'same-id');
});

test('post-human probe input loss resumes once on the same phone and can become ready',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const start=f.store.snapshot().channels[0];await f.readyStart(start);
 const c=f.store.snapshot().channels.find(x=>x.deviceId===start.deviceId),id=c.requestId;
 f.obs.set(c.deviceId,{...failure(c,'post-human-input'),postHumanPageUnknown:true,recoveryFailure:{...failure(c,'post-human-input').recoveryFailure,domain:'state',canResume:true}});
 await f.service.tick();const qs=f.events.filter(e=>e.kind==='query'&&e.id===id);assert.equal(qs.length,2);assert.notEqual(qs[1].options.observationOnly,true);assert.equal(qs[1].device,c.deviceId);
 await f.result(c);assert.ok(f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId).readinessProof);
});
test('probe input recovery remains bounded and frees the reservation after second failure',async()=>{
 const f=fixture();await f.configure([51,52,54]);await f.prepare();await f.service.tick();const start=f.store.snapshot().channels[0];await f.readyStart(start);const c=f.store.snapshot().channels.find(x=>x.deviceId===start.deviceId);
 for(const jobId of ['state-first','state-second']){f.obs.set(c.deviceId,{...failure(c,jobId),postHumanPageUnknown:true,recoveryFailure:{...failure(c,jobId).recoveryFailure,domain:'state',canResume:true}});await f.service.tick();}
 assert.equal(f.events.filter(e=>e.kind==='query'&&e.id===c.requestId).length,2);assert.ok(f.events.some(e=>e.kind==='stop'&&e.device===c.deviceId));
 assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===c.requestId).status,'failed');
});

import {lookupFailureDomain as pageActionFailureDomain} from './lookup-failure-domain.mjs';
for(const reason of ['visual_network_busy','network_refresh_exhausted'])test('network error after bounded refresh is never AI empty; stop ACK then same ID handoff: '+reason,async()=>{
 const diagnostic='local_lookup_result_unconfirmed:'+reason;
 assert.equal(pageActionFailureDomain({result:{errorCode:'alipay_lookup_result_unconfirmed',diagnostic:{runnerReason:diagnostic}}}),'network');
 const f=fixture(),{r,c}=await running(f);
 f.adapter.stop=async c=>{f.events.push({kind:'stop',device:c.deviceId});f.obs.set(c.deviceId,{busy:true});};
 f.obs.set(c.deviceId,{...failure(c,'network-terminal'),recoveryFailure:{...failure(c,'network-terminal').recoveryFailure,domain:'network',reason:diagnostic}});
 await f.service.tick();await f.service.tick();
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
 assert.equal(f.store.snapshot().requests.find(x=>x.lookupId===r.lookupId).status,'rerouting');
 assert.equal((await f.submit('retry-new-client-key')).lookupId,r.lookupId);
 f.obs.set(c.deviceId,{stopped:true});await f.service.tick();
 const next=f.store.snapshot().channels.find(x=>x.requestId===r.lookupId);assert.ok(next);assert.notEqual(next.deviceId,c.deviceId);
 await f.result(next,'续');assert.equal((await f.service.getAsyncResult(r.lookupId,'a')).name,'续');
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,2);
});
test('network failure during probe never makes phone ready or cools its account',async()=>{
 const f=fixture();await f.configure();await f.prepare();await f.service.tick();const c=f.store.snapshot().channels[0];await f.readyStart(c);
 const current=f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId);
 f.obs.set(c.deviceId,{...failure(current,'network-probe'),recoveryFailure:{...failure(current,'network-probe').recoveryFailure,domain:'network',reason:'local_lookup_result_unconfirmed:network_refresh_exhausted'}});
 await f.service.tick();const r=f.store.snapshot().requests.find(x=>x.lookupId===current.requestId);
 assert.equal(r.status,'failed');assert.equal(r.code,'lookup_probe_failed');
 assert.ok(!f.store.snapshot().channels.find(x=>x.deviceId===c.deviceId)?.readinessProof);
 assert.equal(f.events.filter(e=>e.id===r.lookupId&&e.kind==='query').length,1);
});
