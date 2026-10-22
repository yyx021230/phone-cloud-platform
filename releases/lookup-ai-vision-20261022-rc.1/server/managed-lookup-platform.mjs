import {jobEvidence} from './lookup-admin-console.mjs';
import {preparationFailureEvidence} from './lookup-device-availability.mjs';
import crypto from 'node:crypto';
import {lookupPageRecoveryExhausted} from './automation-center.mjs';
import {lookupFailureDomain} from './lookup-failure-domain.mjs';
import {lookupAccountOfflineEvidence,latestAccountWork} from './lookup-account-offline.mjs';
import {holdManagedLookupDispatch} from './managed-lookup-delivery.mjs';
import {MANAGED_LOOKUP_PROTOCOL} from './managed-lookup-store.mjs';
import {managedLookupError} from './managed-lookup.mjs';

export function createManagedLookupAdapter(api){
  const {state}=api;
  const userFor=id=>api.userFor(id);
  const tag=(c,job)=>{job.source='managed-api';job.clientId=c.clientId;};
  function checkpoint(tx){
    const arrays=['automationJobs','automationSessions','windowsTasks','deviceLocks','audit'];
    const keys={automationJobs:'jobId',automationSessions:'sessionId',windowsTasks:'taskId',deviceLocks:'lockId',audit:'auditId'};
    const ids=Object.fromEntries(arrays.map(k=>[k,new Set(state[k].map(x=>x[keys[k]]))]));
    let added={};tx.onRollback(()=>{for(const k of arrays)state[k]=state[k].filter(x=>!added[k]?.has(x[keys[k]]));});
    return ()=>{added=Object.fromEntries(arrays.map(k=>[k,new Set(state[k].filter(x=>!ids[k].has(x[keys[k]])).map(x=>x[keys[k]]))]));};
  }
  async function persist(tx,bundle){
    if(!tx.client)return;
    try{await api.persist({...bundle,transactionClient:tx.client});}
    catch(cause){throw Object.assign(new Error('managed_lookup_persistence_failed',{cause}),{code:'managed_lookup_persistence_failed'});}
  }
  return {
    aiEvidence(c,r){
      const session=state.automationSessions.find(s=>s.sessionId===c.sessionId);
      const job=latestAccountWork(state.automationJobs,c.sessionId),task=state.windowsTasks.find(t=>t.taskId===job?.windowsTaskId);
      if(!session||session.pendingJobId||session.status!=='ready'||!session.accountIdentityVerified||!session.currentAccount||!job||job.kind!=='alipay_name_query'||job.status!=='failed'||task?.status!=='failed'||job.deviceId!==c.deviceId||task.deviceId!==c.deviceId||job.clientReference!==r.lookupId||job.clientId!==r.clientId||job.source!=='managed-api'||job.phoneNumber!==r.phoneNumber||(job.resultId||job.jobId)!==c.queryId||task.payload?.managedLookup?.generation!==c.generation||task.payload?.automationSessionId!==c.sessionId||lookupFailureDomain(job)!=='page')return null;
      const ref=job.result?.screenshot;
      const missing={jobId:job.jobId,taskId:task.taskId,evidenceId:'',evidenceSha256:'',mimeType:'',completedMs:Date.parse(job.completedAt||'')};
      if(!Number.isFinite(missing.completedMs))return null;
      if(!ref?.evidenceId)return missing;
      const evidence=jobEvidence(state,job).find(x=>x.evidenceId===ref.evidenceId);
      const asset=state.evidenceAssets?.find(x=>x.evidenceId===ref.evidenceId&&x.taskId===task.taskId);
      const captured=Date.parse(ref.capturedAt||''),created=Date.parse(job.createdAt||''),completed=Date.parse(job.completedAt||'');
      if(!evidence||!asset||!Number.isFinite(captured)||!Number.isFinite(created)||!Number.isFinite(completed)||captured<created||captured>completed+5000||!Number.isInteger(asset.sizeBytes)||asset.sizeBytes>8000000||!/^[a-f0-9]{64}$/.test(asset.sha256||''))return missing;
      return {jobId:job.jobId,taskId:task.taskId,evidenceId:asset.evidenceId,evidenceSha256:asset.sha256,mimeType:asset.mimeType,capturedAt:ref.capturedAt};
    },
    async recordAiResult(c,r,tx,binding){
      const session=state.automationSessions.find(s=>s.sessionId===c.sessionId),job=state.automationJobs.find(j=>j.jobId===binding.jobId);
      if(!session||!job||session.pendingJobId||session.status!=='ready')throw managedLookupError('lookup_ai_state_changed',409);
      const before=structuredClone(session);tx.onRollback(()=>{for(const k of Object.keys(session))delete session[k];Object.assign(session,before);});
      const existing=session.results?.find(x=>x.resultId===c.queryId);
      if(!existing||existing.status!=='needs_recovery')throw managedLookupError('lookup_ai_state_changed',409);
      api.result(session,job,{status:r.status,name:r.name,realNameTailCharacter:r.name?.match(/[（(]\*+(?:·\*+)*([\u3400-\u9fff])[）)]$/u)?.[1]||'',stage:r.name?'已取得姓名':'未取得姓名',errorCode:'',aiResolution:{source:'query_compatibility_screenshot',at:r.completedAt,evidenceId:binding.evidenceId}});
      session.updatedAt=r.completedAt;
      await persist(tx,{automationSession:session});
    },
    preparationFailure(c){
      const job=latestAccountWork(state.automationJobs,c.sessionId),task=state.windowsTasks.find(t=>t.taskId===job?.windowsTaskId);
      if(job?.deviceId!==c.deviceId||task?.status!=='failed'||(job.kind==='alipay_name_query'&&(job.resultId||job.jobId)!==c.queryId))return null;
      return preparationFailureEvidence(job);
    },
    legacyPageIsolation(d){
      // Reclassify only three consecutive, terminal managed START page errors
      // ending at the persisted trip time. Mixed/absent/older evidence stays shut.
      const jobs=state.automationJobs.filter(j=>j.deviceId===d.deviceId&&['alipay_name_start','alipay_name_query'].includes(j.kind)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,3);
      if(jobs.length!==3||!jobs.every(j=>j.source==='managed-api'&&j.kind==='alipay_name_start'&&preparationFailureEvidence(j)?.domain==='page'&&state.windowsTasks.some(t=>t.taskId===j.windowsTaskId&&t.status==='failed')))return null;
      const last=Date.parse(jobs[0].completedAt||'');
      if(!Number.isFinite(last)||!Number.isFinite(d.lookupUnavailableAt)||d.lookupUnavailableAt-last<0||d.lookupUnavailableAt-last>10000)return null;
      return {domain:'page',code:jobs[0].result.errorCode,jobIds:jobs.map(j=>j.jobId)};
    },
    legacyLoginIsolation(id){
      const jobs=state.automationJobs.filter(j=>j.deviceId===id&&['alipay_name_start','alipay_name_query'].includes(j.kind)).reverse().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,3);
      if(jobs.length!==3||!jobs.every(j=>lookupAccountOfflineEvidence(j)))return null;
      return lookupAccountOfflineEvidence(jobs[0],state.automationSessions.find(s=>s.sessionId===jobs[0].sessionId));
    },
    supportsReadiness(id){const d=state.devices.find(d=>d.deviceId===id);return Boolean(state.windowsAgents.find(a=>a.agentId===d?.adb?.agentId)?.lookupRuntimeId);},
    readinessIdentity(c){const s=state.automationSessions.find(s=>s.sessionId===c.sessionId),d=state.devices.find(d=>d.deviceId===c.deviceId),a=state.windowsAgents.find(a=>a.agentId===d?.adb?.agentId);if(!s?.accountIdentityVerified||!s.currentAccount||!a?.lookupRuntimeId||(d.lookupAccountCooldowns||[]).some(row=>row.account===s.currentAccount&&Date.parse(row.cooldownUntil)>Date.now()))return '';return crypto.createHash('sha256').update(JSON.stringify([c.generation,c.sessionId,s.currentAccount,a.lookupRuntimeId])).digest('hex');},
    isOffline(c){
      const d=state.devices.find(d=>d.deviceId===c.deviceId),a=state.windowsAgents.find(a=>a.agentId===d?.adb?.agentId);
      return !d||!api.online(d)||!a||a.enabled===false||!Number.isFinite(Date.parse(a.lastSeenAt))||Date.now()-Date.parse(a.lastSeenAt)>api.onlineMs;
    },
    screenActive: c => Boolean(api.screenActive(c.deviceId)),
    canStop:c=>{const d=state.devices.find(d=>d.deviceId===c.deviceId);return !!d&&api.online(d);},
    clientValid:id=>Boolean(userFor(id)),
    clientOptions:()=>api.clientIds().filter(id=>userFor(id)),
    validateDevice(id,n,previouslyBound=false){if(previouslyBound&&state.devices.some(d=>d.deviceId===id))return;const matches=state.devices.filter(d=>String(d.deviceName).trim()===String(n));if(matches.length!==1||matches[0].deviceId!==id)throw managedLookupError('pool_device_mapping_not_unique');},
    resolveNumber(n){const matches=state.devices.filter(d=>String(d.deviceName).trim()===String(n));return {deviceNumber:n,matches:matches.length,deviceId:matches.length===1?matches[0].deviceId:'',...(matches.length===1?this.health(matches[0].deviceId):{ready:false,reason:'mapping_not_unique'})};},
    health(id,{allowScreenControl=false}={}){
      const d=state.devices.find(d=>d.deviceId===id);if(!d)return {ready:false,reason:'device_missing'};
      const a=state.windowsAgents.find(a=>a.agentId===d.adb?.agentId);
      if(!api.listed(d)||!api.online(d)||!a||a.enabled===false||(!Number.isFinite(Date.parse(a.lastSeenAt))||Date.now()-Date.parse(a.lastSeenAt)>api.onlineMs))return {ready:false,reason:'device_or_agent_offline'};
      if(a.managedLookupProtocol!==MANAGED_LOOKUP_PROTOCOL)return {ready:false,reason:'managed_agent_upgrade_required'};
      if(a.health?.airtest?.enabled!==true||a.health?.airtest?.ok!==true)return {ready:false,reason:'lookup_executor_not_ready'};
      if(!allowScreenControl&&api.screenActive(id))return {ready:false,reason:'screen_control_active'};
      const lock=api.lockFor(id);if(lock&&!lock.managedLookupGeneration)return {ready:false,reason:'device_busy'};
      if(api.allCooling(d))return {ready:false,reason:'accounts_cooling'};
      return {ready:true,reason:''};
    },
    async start(c,r,tx){
      const mark=checkpoint(tx);const track=fn=>{try{return fn();}finally{mark();}};const user=userFor(c.clientId);if(!user)throw managedLookupError('managed_lookup_not_authorized',403);
      const device=state.devices.find(d=>d.deviceId===c.deviceId);const session=track(()=>api.createSession({userId:user.userId,deviceId:c.deviceId}));
      Object.assign(session,{source:'managed-api',clientId:c.clientId,managedLookupGeneration:c.generation});c.sessionId=session.sessionId;
      const job=track(()=>api.createJob({kind:'alipay_name_start',userId:user.userId,deviceId:c.deviceId,sessionId:session.sessionId}));tag(c,job);session.pendingJobId=job.jobId;
      const lock=track(()=>api.acquireLock(device,job,{userId:user.userId,user,role:'system'},{taskId:session.sessionId}));lock.managedLookupGeneration=c.generation;session.lockId=lock.lockId;
      const task=track(()=>api.queueTask(device,job));holdManagedLookupDispatch(task,tx);mark();await persist(tx,{automationSession:session,automationJob:job,windowsTask:task,deviceLock:lock});
    },
    async query(c,r,tx,{recovery=false,automaticRecovery=false,prepared=false,probePhone='',verified=false,observationOnly=false}={}){
      const mark=checkpoint(tx);const track=fn=>{try{return fn();}finally{mark();}};const session=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!session||session.pendingJobId||session.status!=='ready')throw managedLookupError('managed_session_not_ready',409);
      const old=structuredClone(session);tx.onRollback(()=>Object.assign(session,old));
      if(!recovery)c.queryIdentity=this.readinessIdentity(c);
      const source=recovery?api.recovery(session):null;if(recovery&&(!source||(source.phase!=='start'&&source.resultId!==r.queryId)))throw managedLookupError('managed_recovery_not_ready',409);
      const device=state.devices.find(d=>d.deviceId===c.deviceId);const startup=source?.phase==='start';const job=track(()=>api.createJob({kind:startup?'alipay_name_start':'alipay_name_query',userId:session.userId,deviceId:c.deviceId,sessionId:c.sessionId,phoneNumber:startup?'':r.phoneNumber,resultId:recovery?r.queryId||'':'',resumeAfterHumanVerification:recovery,restartAfterHumanVerification:recovery&&!automaticRecovery}));tag(c,job);if(prepared){job.preparedLookup={probePhone,verifiedAccount:verified?session.currentAccount:'',observationOnlyResume:observationOnly===true};}job.clientReference=r.lookupId;job.consentReference=r.consentReference;
      session.status=startup?'starting':'querying';session.pendingJobId=job.jobId;session.updatedAt=new Date().toISOString();if(startup){session.startupHumanVerification.status='queued';}else{const result=api.result(session,job,{status:'queued',stage:'平台自动分配手机，等待查询'});r.queryId=c.queryId=result.resultId;}
      const task=track(()=>api.queueTask(device,job));holdManagedLookupDispatch(task,tx);mark();await persist(tx,{automationSession:session,automationJob:job,windowsTask:task});
    },
    observe(c){
      const s=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!s)return {unknown:true};
      const result=s.results.find(r=>r.resultId===c.queryId);
      // Keep lifecycle flags while exposing the received result of this exact
      // query. A stop/connection change must not hide its completed name.
      const completed=result&&['succeeded','not_found'].includes(result.status)?{result}:{};
      const job=state.automationJobs.find(j=>j.jobId===s.pendingJobId);
      if(s.pendingJobId){const task=state.windowsTasks.find(t=>t.taskId===job?.windowsTaskId);if(!task||['stalled','expired'].includes(task.status)||!api.online(state.devices.find(d=>d.deviceId===c.deviceId)))return {...completed,unknown:true};return {...completed,busy:true,switching:s.status==='switching'};}
      const accountOffline=lookupAccountOfflineEvidence(latestAccountWork(state.automationJobs,c.sessionId),s);
      if(accountOffline)return {...completed,accountOffline,stopped:s.status==='ended'||s.status==='failed',ready:false};
      // A confirmed terminal session overrides historical per-result prompts.
      // Expiry alone still cannot prove that a device stopped.
      if(['ended','expired','failed'].includes(s.status))return {...completed,stopped:s.status!=='expired',startFailed:!c.queryId,ready:false};
      if(s.status==='needs_human_verification'||s.startupHumanVerification?.status==='needs_human_verification'||result?.status==='needs_human_verification')return {...completed,human:true};
      if(s.startupHumanVerification?.status==='needs_recovery'||result?.status==='needs_recovery'){
        const failed=latestAccountWork(state.automationJobs,c.sessionId),task=state.windowsTasks.find(t=>t.taskId===failed?.windowsTaskId);
        const terminal=failed?.kind==='alipay_name_query'&&failed.status==='failed'&&task?.status==='failed'&&c.queryId&&(failed.resultId||failed.jobId)===c.queryId;
        const rawReason=failed?.result?.diagnostic?.runnerReason;
        const reason=lookupPageRecoveryExhausted(failed)?'poco_query_page_recovery_failed':['local_lookup_result_unconfirmed:ocr_reader_timeout','local_lookup_result_unconfirmed:observation_budget_exhausted'].includes(rawReason)?rawReason:'';
        return {...completed,recovery:true,postHumanPageUnknown:failed?.postHumanCheck===true&&failed?.result?.errorCode==='alipay_lookup_result_unconfirmed',...(terminal?{recoveryFailure:{jobId:failed.jobId,identity:this.readinessIdentity(c),reason,domain:lookupFailureDomain(failed)}}:{})};
      }
      if(result)return {result,exhausted:s.requiresAccountSwitch===true,ready:s.status==='ready'};
      return {ready:s.status==='ready',exhausted:s.requiresAccountSwitch===true};
    },
    async quarantineRoundStop(c,tx){
      const session=state.automationSessions.find(s=>s.sessionId===c.sessionId&&s.deviceId===c.deviceId);
      if((!c.roundStopPreparationId&&c.offlineHandoffSince===undefined&&c.offlineHandoffAt===undefined)||!session||session.managedLookupGeneration!==c.generation)throw managedLookupError('managed_stop_fence_binding_missing',409);
      const done=new Set(['succeeded','failed','cancelled','expired']);
      const jobs=state.automationJobs.filter(j=>j.sessionId===c.sessionId&&j.deviceId===c.deviceId&&/^alipay_name_(start|query|switch|stop)$/.test(j.kind)&&!done.has(j.status));
      const tasks=state.windowsTasks.filter(t=>t.deviceId===c.deviceId&&t.payload?.automationSessionId===c.sessionId&&t.payload?.managedLookup?.generation===c.generation&&/^alipay_name_(start|query|switch|stop)$/.test(t.type)&&!done.has(t.status));
      // Validate linked tasks before mutating anything. Never cancel another
      // generation or unrelated task because a stale session points at it.
      for(const j of jobs){
        const t=state.windowsTasks.find(t=>t.taskId===j.windowsTaskId);
        if(t&&(t.deviceId!==c.deviceId||t.payload?.automationSessionId!==c.sessionId||t.payload?.managedLookup?.generation!==c.generation))throw managedLookupError('managed_stop_fence_binding_mismatch',409);
      }
      const affected=[session,...jobs,...tasks],copies=affected.map(x=>structuredClone(x));
      tx.onRollback(()=>affected.forEach((x,i)=>{for(const k of Object.keys(x))delete x[k];Object.assign(x,copies[i]);}));
      const reason=c.roundStopPreparationId?'lookup_round_stopped':'lookup_device_offline_reassigned';
      for(const j of jobs)api.cancelJob(j,reason,{releaseLock:false});
      // Includes leased or handover-pending tasks whose job record is absent.
      // Terminal task guards already reject late payload/ACK/status delivery.
      for(const t of tasks){t.status='cancelled';t.completedAt=t.updatedAt=new Date().toISOString();t.result={...(t.result||{}),errorCode:reason};}
      session.status='stopping';session.pendingJobId='';session.updatedAt=new Date().toISOString();
      await persist(tx,{automationSession:session,automationJobs:jobs,windowsTasks:tasks});
    },
    async stop(c,tx){
      const mark=checkpoint(tx);const track=fn=>{try{return fn();}finally{mark();}};const s=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!s)return;
      const old=structuredClone(s);tx.onRollback(()=>Object.assign(s,old));let cancelledJob=null,cancelledTask=null;
      if(s.pendingJobId){const job=state.automationJobs.find(j=>j.jobId===s.pendingJobId);if(job){const copy=structuredClone(job),task=state.windowsTasks.find(t=>t.taskId===job.windowsTaskId),taskCopy=task&&structuredClone(task);tx.onRollback(()=>{Object.assign(job,copy);if(task)Object.assign(task,taskCopy);});api.cancelJob(job,'managed_pool_stopping',{releaseLock:false});cancelledJob=job;cancelledTask=task;}}
      const device=state.devices.find(d=>d.deviceId===c.deviceId);
      if(!device||!api.online(device))throw managedLookupError('managed_stop_requires_online',503);
      const job=track(()=>api.createJob({kind:'alipay_name_stop',userId:s.userId,deviceId:c.deviceId,sessionId:c.sessionId}));tag(c,job);s.status='stopping';s.pendingJobId=job.jobId;const task=track(()=>api.queueTask(device,job));holdManagedLookupDispatch(task,tx);mark();await persist(tx,{automationSession:s,automationJob:job,windowsTask:task,automationJobs:cancelledJob?[cancelledJob]:[],windowsTasks:cancelledTask?[cancelledTask]:[]});
    }
  };
}
