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
  async function persist(tx,bundle){if(tx.client)await api.persist({...bundle,transactionClient:tx.client});}
  return {
    clientValid:id=>Boolean(userFor(id)),
    clientOptions:()=>api.clientIds().filter(id=>userFor(id)),
    validateDevice(id,n){const matches=state.devices.filter(d=>String(d.deviceName).trim()===String(n));if(matches.length!==1||matches[0].deviceId!==id)throw managedLookupError('pool_device_mapping_not_unique');},
    resolveNumber(n){const matches=state.devices.filter(d=>String(d.deviceName).trim()===String(n));return {deviceNumber:n,matches:matches.length,deviceId:matches.length===1?matches[0].deviceId:'',...(matches.length===1?this.health(matches[0].deviceId):{ready:false,reason:'mapping_not_unique'})};},
    health(id){
      const d=state.devices.find(d=>d.deviceId===id);if(!d)return {ready:false,reason:'device_missing'};
      const a=state.windowsAgents.find(a=>a.agentId===d.adb?.agentId);
      if(!api.listed(d)||!api.online(d)||!a||a.enabled===false||(!Number.isFinite(Date.parse(a.lastSeenAt))||Date.now()-Date.parse(a.lastSeenAt)>api.onlineMs))return {ready:false,reason:'device_or_agent_offline'};
      if(a.managedLookupProtocol!==MANAGED_LOOKUP_PROTOCOL)return {ready:false,reason:'managed_agent_upgrade_required'};
      if(api.screenActive(id))return {ready:false,reason:'screen_control_active'};
      const lock=api.lockFor(id);if(lock&&!lock.managedLookupGeneration)return {ready:false,reason:'device_busy'};
      if(api.allCooling(d))return {ready:false,reason:'accounts_cooling'};
      return {ready:true,reason:''};
    },
    async start(c,r,tx){
      const mark=checkpoint(tx);const user=userFor(c.clientId);if(!user)throw managedLookupError('managed_lookup_not_authorized',403);
      const device=state.devices.find(d=>d.deviceId===c.deviceId);const session=api.createSession({userId:user.userId,deviceId:c.deviceId});
      Object.assign(session,{source:'managed-api',clientId:c.clientId,managedLookupGeneration:c.generation});c.sessionId=session.sessionId;
      const job=api.createJob({kind:'alipay_name_start',userId:user.userId,deviceId:c.deviceId,sessionId:session.sessionId});tag(c,job);session.pendingJobId=job.jobId;
      const lock=api.acquireLock(device,job,{userId:user.userId,user,role:'system'},{taskId:session.sessionId});lock.managedLookupGeneration=c.generation;session.lockId=lock.lockId;
      const task=api.queueTask(device,job);mark();await persist(tx,{automationSession:session,automationJob:job,windowsTask:task,deviceLock:lock});
    },
    async query(c,r,tx){
      const mark=checkpoint(tx);const session=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!session||session.pendingJobId||session.status!=='ready')throw managedLookupError('managed_session_not_ready',409);
      const old=structuredClone(session);tx.onRollback(()=>Object.assign(session,old));
      const device=state.devices.find(d=>d.deviceId===c.deviceId);const job=api.createJob({kind:'alipay_name_query',userId:session.userId,deviceId:c.deviceId,sessionId:c.sessionId,phoneNumber:r.phoneNumber});tag(c,job);job.clientReference=r.lookupId;job.consentReference=r.consentReference;
      session.status='querying';session.pendingJobId=job.jobId;session.updatedAt=new Date().toISOString();const result=api.result(session,job,{status:'queued',stage:'平台自动分配手机，等待查询'});r.queryId=c.queryId=result.resultId;
      const task=api.queueTask(device,job);mark();await persist(tx,{automationSession:session,automationJob:job,windowsTask:task});
    },
    observe(c){
      const s=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!s)return {unknown:true};
      const result=s.results.find(r=>r.resultId===c.queryId);
      const job=state.automationJobs.find(j=>j.jobId===s.pendingJobId);
      if(s.pendingJobId){const task=state.windowsTasks.find(t=>t.taskId===job?.windowsTaskId);if(!task||['stalled','expired'].includes(task.status)||!api.online(state.devices.find(d=>d.deviceId===c.deviceId)))return {unknown:true};return {busy:true,switching:s.status==='switching'};}
      if(s.status==='needs_human_verification'||s.startupHumanVerification?.status==='needs_human_verification'||result?.status==='needs_human_verification')return {human:true};
      if(s.startupHumanVerification?.status==='needs_recovery'||result?.status==='needs_recovery')return {recovery:true};
      if(['ended','expired','failed'].includes(s.status))return {stopped:s.status!=='expired',startFailed:!c.queryId};
      if(result)return {result,exhausted:s.requiresAccountSwitch===true,ready:s.status==='ready'};
      return {ready:s.status==='ready',exhausted:s.requiresAccountSwitch===true};
    },
    async stop(c,tx){
      const mark=checkpoint(tx);const s=state.automationSessions.find(s=>s.sessionId===c.sessionId);if(!s)return;
      const old=structuredClone(s);tx.onRollback(()=>Object.assign(s,old));let cancelledJob=null,cancelledTask=null;
      if(s.pendingJobId){const job=state.automationJobs.find(j=>j.jobId===s.pendingJobId);if(job){const copy=structuredClone(job),task=state.windowsTasks.find(t=>t.taskId===job.windowsTaskId),taskCopy=task&&structuredClone(task);tx.onRollback(()=>{Object.assign(job,copy);if(task)Object.assign(task,taskCopy);});api.cancelJob(job,'managed_pool_stopping',{releaseLock:false});cancelledJob=job;cancelledTask=task;}}
      const device=state.devices.find(d=>d.deviceId===c.deviceId);
      if(!device||!api.online(device))throw managedLookupError('managed_stop_requires_online',503);
      const job=api.createJob({kind:'alipay_name_stop',userId:s.userId,deviceId:c.deviceId,sessionId:c.sessionId});tag(c,job);s.status='stopping';s.pendingJobId=job.jobId;const task=api.queueTask(device,job);mark();await persist(tx,{automationSession:s,automationJob:job,windowsTask:task,automationJobs:cancelledJob?[cancelledJob]:[],windowsTasks:cancelledTask?[cancelledTask]:[]});
    }
  };
}
