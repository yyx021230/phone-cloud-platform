import test from 'node:test';import assert from 'node:assert/strict';import {createManagedLookupAdapter} from './managed-lookup-platform.mjs';
function fixture(){const at=new Date().toISOString(),c={sessionId:'s',deviceId:'d',queryId:'q',generation:'g'},r={lookupId:'r',clientId:'a',phoneNumber:'19900000000'},session={sessionId:'s',status:'ready',accountIdentityVerified:true,currentAccount:'A',results:[{resultId:'q',status:'needs_recovery'}]},job={jobId:'j',sessionId:'s',deviceId:'d',kind:'alipay_name_query',status:'failed',windowsTaskId:'t',clientReference:'r',clientId:'a',source:'managed-api',phoneNumber:r.phoneNumber,resultId:'q',createdAt:at,completedAt:at,result:{errorCode:'alipay_lookup_result_unconfirmed',screenshot:{evidenceId:'e',capturedAt:at}}},task={taskId:'t',deviceId:'d',status:'failed',payload:{automationSessionId:'s',managedLookup:{generation:'g'}}},asset={evidenceId:'e',taskId:'t',kind:'screenshot',mimeType:'image/png',sizeBytes:10,sha256:'a'.repeat(64)};
const state={automationSessions:[session],automationJobs:[job],windowsTasks:[task],evidenceAssets:[asset]};const adapter=createManagedLookupAdapter({state,result:(s,j,p)=>Object.assign(s.results[0],p),persist:async()=>{}});return {state,session,job,task,asset,c,r,adapter};}
test('exact terminal query screenshot available',()=>{const f=fixture();assert.equal(f.adapter.aiEvidence(f.c,f.r).evidenceId,'e');});
for(const mode of ['task_running','other_generation','other_query','other_phone','other_client','probe_start','login','transport','new_job','session_busy','other_session'])test('refuse non-compatible evidence '+mode,()=>{const f=fixture();if(mode==='task_running')f.task.status='running';if(mode==='other_generation')f.task.payload.managedLookup.generation='other';if(mode==='other_query')f.job.resultId='other';if(mode==='other_phone')f.job.phoneNumber='18800000000';if(mode==='other_client')f.job.clientId='b';if(mode==='probe_start')f.job.kind='alipay_name_start';if(mode==='login')f.job.result.errorCode='alipay_login_required';if(mode==='transport')f.job.result.diagnostic={runnerReason:'device offline'};if(mode==='new_job')f.state.automationJobs.push({...f.job,jobId:'new',kind:'alipay_name_start',createdAt:new Date(Date.now()+10000).toISOString()});if(mode==='session_busy')f.session.pendingJobId='other';if(mode==='other_session')f.task.payload.automationSessionId='other';assert.equal(f.adapter.aiEvidence(f.c,f.r),null);});
for(const mode of ['absent','wrongtask','mime','old','size','digest'])test('bad screenshot becomes bounded missing evidence '+mode,()=>{const f=fixture();if(mode==='absent')f.state.evidenceAssets=[];if(mode==='wrongtask')f.asset.taskId='other';if(mode==='mime')f.asset.mimeType='text/plain';if(mode==='old')f.job.result.screenshot.capturedAt='2000-01-01T00:00:00Z';if(mode==='size')f.asset.sizeBytes=8000001;if(mode==='digest')f.asset.sha256='bad';assert.equal(f.adapter.aiEvidence(f.c,f.r).evidenceId,'');});
test('record result updates original visible row; failed physical job stays historical',async()=>{const f=fixture();await f.adapter.recordAiResult(f.c,{...f.r,status:'not_found',name:'',completedAt:new Date().toISOString()},{onRollback:()=>{}},{jobId:'j',evidenceId:'e'});assert.equal(f.session.results[0].status,'not_found');assert.equal(f.session.results[0].name,'');assert.equal(f.job.status,'failed');});

test('production shape: screenshot ID exists only on persisted finish event',()=>{
 const f=fixture();const ref={...f.job.result.screenshot,mimeType:'image/png',sizeBytes:10};delete ref.evidenceId;
 f.job.result.screenshot=ref;f.task.result={screenshot:{...ref}};
 f.task.events=[{phase:'finish',screenshot:{...ref,evidenceId:'e'}}];
 assert.equal(f.adapter.aiEvidence(f.c,f.r).evidenceId,'e');
});
for(const mode of ['old_capture','other_task','other_size','other_mime','ambiguous','missing_result_capture'])test('event fallback rejects '+mode,()=>{
 const f=fixture();const ref={capturedAt:f.job.createdAt,mimeType:'image/png',sizeBytes:10};f.job.result.screenshot={...ref};f.task.events=[{phase:'finish',screenshot:{...ref,evidenceId:'e'}}];
 if(mode==='old_capture')f.task.events[0].screenshot.capturedAt='2000-01-01T00:00:00Z';
 if(mode==='other_task')f.asset.taskId='other';
 if(mode==='other_size')f.asset.sizeBytes=11;
 if(mode==='other_mime')f.asset.mimeType='image/jpeg';
 if(mode==='ambiguous'){f.state.evidenceAssets.push({...f.asset,evidenceId:'second'});f.task.events.push({screenshot:{...ref,evidenceId:'second'}});}
 if(mode==='missing_result_capture')delete f.job.result.screenshot.capturedAt;
 assert.equal(f.adapter.aiEvidence(f.c,f.r).evidenceId,'');
});

for(const reason of ['local_lookup_result_unconfirmed:input_changed','local_lookup_result_unconfirmed:post_human_input_changed','local_lookup_result_unconfirmed:foreground_changed','poco_query_resume_state_mismatch:length=0;emptyReinputAllowed=false'])test('non-result page never qualifies for AI: '+reason,()=>{
 const f=fixture();f.job.result.diagnostic={runnerReason:reason};assert.equal(f.adapter.aiEvidence(f.c,f.r),null);
});
for(const reason of ['local_lookup_result_unconfirmed:input_changed','local_lookup_result_unconfirmed:post_human_input_changed'])test('lost input resumes original query outside read-only image branch: '+reason,()=>{
 const f=fixture();f.state.devices=[{deviceId:'d',adb:{agentId:'agent'}}];f.state.windowsAgents=[{agentId:'agent',lookupRuntimeId:'runtime'}];f.job.result.diagnostic={runnerReason:reason};
 const observation=f.adapter.observe(f.c);assert.equal(observation.recoveryFailure.domain,'state');assert.equal(observation.recoveryFailure.canResume,true);
});
for(const mode of ['exact','running','other_generation','other_query','other_device','other_client','other_session','unclassified'])test('killed terminal task recovery requires exact binding: '+mode,()=>{
 const f=fixture();f.session.results[0].status='failed';f.job.result={errorCode:'task_failed',message:'server_error',uiSnapshot:'Killed'};
 f.c.clientId='a';f.state.devices=[{deviceId:'d',adb:{agentId:'agent'}}];f.state.windowsAgents=[{agentId:'agent',lookupRuntimeId:'runtime'}];
 if(mode==='running')f.task.status='running';if(mode==='other_generation')f.task.payload.managedLookup.generation='other';if(mode==='other_query')f.job.resultId='other';if(mode==='other_device')f.task.deviceId='other';if(mode==='other_client')f.job.clientId='other';if(mode==='other_session')f.task.payload.automationSessionId='other';if(mode==='unclassified')f.job.result.uiSnapshot='';
 const o=f.adapter.observe(f.c);if(mode==='exact'){assert.equal(o.recovery,true);assert.equal(o.recoveryFailure.canResume,false);assert.equal(o.recoveryFailure.domain,'execution');}else assert.equal(o.recoveryFailure,undefined);
});
for(const reason of ['observation_budget_exhausted','visual_card_not_proven','visual_card_changed','post_human_unknown','protected_visual_page'])test('only terminal result-specific reasons skip redundant observation '+reason,()=>{const f=fixture();f.job.result.diagnostic={runnerReason:'local_lookup_result_unconfirmed:'+reason};assert.equal(f.adapter.aiEvidence(f.c,f.r).directResult,['observation_budget_exhausted','visual_card_not_proven','visual_card_changed'].includes(reason));});

for(const reason of ['poco_query_page_recovery_failed:local_lookup_result_unconfirmed:observation_budget_exhausted','poco_query_resume_failed:local_lookup_result_unconfirmed:visual_card_not_proven','poco_query_resume_observation_failed:local_lookup_result_unconfirmed:visual_card_changed','local_lookup_result_unconfirmed:ocr_reader_timeout','local_lookup_result_unconfirmed:ocr_reader_unavailable'])test('terminal image fallback survives exact wrapper or unavailable local reader '+reason,()=>{const f=fixture();f.job.result.diagnostic={runnerReason:reason};assert.equal(f.adapter.aiEvidence(f.c,f.r)?.directResult,true);});
for(const reason of ['poco_query_page_recovery_failed:local_lookup_result_unconfirmed:post_human_input_changed','poco_query_resume_failed:local_lookup_result_unconfirmed:network_refresh_exhausted','poco_query_resume_observation_failed:local_lookup_result_unconfirmed:foreground_changed','poco_query_page_recovery_failed:device offline'])test('wrapped state or transport is never a terminal AI result '+reason,()=>{const f=fixture();f.job.result.diagnostic={runnerReason:reason};assert.equal(f.adapter.aiEvidence(f.c,f.r),null);});
