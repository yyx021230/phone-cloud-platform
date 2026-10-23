import {ROUND_IDLE_MS,roundDeadline,roundIsActive} from './lookup-round-idle.mjs';
import {roundStopping} from './lookup-round-stop.mjs';
import {lookupDeviceUnavailable,preparationBlocked,pagePreparationRetryAt,recordLookupPreparationFailure,recordLookupPreparationSuccess} from './lookup-device-availability.mjs';
import crypto from 'node:crypto';
import {accountOfflineBlocked,clearAccountOffline} from './lookup-account-offline.mjs';
export const PREPARED_PROTOCOL='prepared-v1';
// Local freshness policy, not a guarantee about the upstream verification timer.
export const READINESS_IDLE_TTL_MS=300000;
const TERMINAL=new Set(['succeeded','not_found','failed','cancelled','expired']);
const error=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export function createLookupReadiness({adapter,now=Date.now,probePhone='',idleMs=ROUND_IDLE_MS}){
  const owner=crypto.randomUUID();
  const configured=()=>/^1[3-9]\d{9}$/.test(probePhone);
  const current=(s,id)=>(s.preparations||[]).find(p=>p.clientId===id);
  const active=(s,id)=>{const p=current(s,id);return s.config.enabled&&p&&roundIsActive(s,p,now())&&s.grants.some(g=>g.clientId===id&&g.enabled)&&adapter.clientValid(id)?p:null;};
  const identity=c=>{try{return adapter.readinessIdentity?.(c)||'';}catch{return '';}};
  const healthy=id=>{try{return adapter.health(id).ready;}catch{return false;}};
  function valid(s,c,{ignoreFreshness=false}={}){
    const p=active(s,c.clientId),proof=c.readinessProof;
    if(!p||!proof||proof.owner!==owner||proof.preparationId!==p.preparationId||proof.generation!==c.generation||proof.sessionId!==c.sessionId||!identity(c)||proof.identity!==identity(c)||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled&&!lookupDeviceUnavailable(d)&&!preparationBlocked(s,d,c.clientId)&&!d.accountOffline)||!healthy(c.deviceId))return false;
    const lastSuccess=proof.lastSuccessAt??proof.verifiedAt;
    if(!ignoreFreshness&&c.phase==='idle'&&(!Number.isFinite(lastSuccess)||now()<lastSuccess||now()-lastSuccess>=READINESS_IDLE_TTL_MS))return false;
    let o;try{o=adapter.observe(c);}catch{return false;}return !o.accountOffline&&!o.human&&!o.recovery&&!o.unknown&&!o.switching&&!o.stopped&&!o.exhausted&&!o.startFailed&&(o.busy||o.ready!==false)&&c.phase!=='stopping';
  }
  // Retain the same healthy session only when time alone invalidated its proof.
  const idleRefresh=(s,c)=>c.phase==='idle'&&valid(s,c,{ignoreFreshness:true})&&
    now()-(c.readinessProof.lastSuccessAt??c.readinessProof.verifiedAt)>=READINESS_IDLE_TTL_MS;
  const targetCount=s=>Math.min(5,s.config.concurrency);
  const enabled=(s,id)=>Boolean(current(s,id));
  // Admission belongs to a round; device proofs remain independently short-lived.
  // For an upgraded live round, an already accepted prepared business request
  // proves that the old first-two gate passed. Never borrow another round/client.
  const previouslyOpened=(s,p)=>Boolean(p&&(Number.isFinite(p.admissionOpenedAt)||p.admissionPolicy!==1&&s.requests.some(r=>
    r.clientId===p.clientId&&r.resultProtocol===PREPARED_PROTOCOL&&r.purpose!=='readiness_probe'&&
    Number.isFinite(Date.parse(r.createdAt))&&Date.parse(r.createdAt)>=p.createdAt&&Date.parse(r.createdAt)<=now())));
  function rememberAdmission(s,p){
    if(p&&active(s,p.clientId)&&!Number.isFinite(p.admissionOpenedAt)&&
      (previouslyOpened(s,p)||s.channels.filter(c=>c.clientId===p.clientId&&valid(s,c)).length>=2))p.admissionOpenedAt=now();
  }
  function status(s,id){
    const p=current(s,id),a=active(s,id),cs=s.channels.filter(c=>c.clientId===id&&valid(s,c));
    return {ok:true,preparationId:p?.preparationId||'',status:p?.stopRequestedAt!==undefined?(p.stoppedAt!==undefined?'stopped':'stopping'):!a?'expired':(previouslyOpened(s,p)||cs.length>=2)?'ready':'preparing',ready:Boolean(a&&(previouslyOpened(s,p)||cs.length>=2)),readyCount:cs.length,idleCount:cs.filter(c=>c.phase==='idle').length,minimumReady:2,targetCount:targetCount(s),expiresAt:p&&roundDeadline(s,p,now())!==null?new Date(roundDeadline(s,p,now())).toISOString():null};
  }
  function submissionFeedback(s,id){
    const value=status(s,id),noCapacity=['ready','preparing'].includes(value.status)&&value.readyCount===0;
    return {acceptingRequests:Boolean(value.ready&&value.readyCount>0),...(noCapacity?{code:'lookup_no_available_device',retryAfterSeconds:30}:{})};
  }
  function prepare(s,{clientId,key}){
    if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key||''))throw error('invalid_idempotency_key');
    if(!s.grants.some(g=>g.clientId===clientId&&g.enabled)||!adapter.clientValid(clientId))throw error('managed_lookup_not_authorized',403);
    if(!s.config.enabled)throw error('lookup_pool_disabled',503);
    if(!configured())throw error('lookup_probe_not_configured',503);
    if(s.config.concurrency<2)throw error('lookup_preparation_capacity',503);
    s.preparations||=[];s.preparationKeys||=[];
    const p=current(s,clientId),old=s.preparationKeys.find(k=>k.clientId===clientId&&k.key===key);
    if(old&&old.preparationId!==p?.preparationId)throw error('lookup_preparation_expired',409);
    if(old){const a=active(s,clientId);rememberAdmission(s,a);if(a)a.probeDemand=status(s,clientId).readyCount<targetCount(s);return status(s,clientId);}
    if(roundStopping(s,clientId)||(p&&p.stopRequestedAt===undefined&&!roundIsActive(s,p,now())))throw error('lookup_round_stopping',409);
    if(s.preparationKeys.filter(k=>k.clientId===clientId).length>=1000)throw error('lookup_preparation_key_limit',429);
    let a=active(s,clientId);
    if(!a){a={preparationId:crypto.randomUUID(),clientId,createdAt:now(),admissionPolicy:1,idlePolicy:1,idleTimeoutMs:idleMs,idleSince:now(),expiresAt:now()+idleMs,probeAttempts:[]};if(p)s.preparations.splice(s.preparations.indexOf(p),1);s.preparations.push(a);}
    // A new explicit prepare key permits one new probe round; polling the
    // same key above does not release an offline-account exclusion. Existing
    // proofs, queued business IDs and other clients are not reset.
    rememberAdmission(s,a);
    a.loginEpoch=crypto.randomUUID();
    a.probeDemand=status(s,clientId).readyCount<targetCount(s);
    s.preparationKeys.push({clientId,key,preparationId:a.preparationId});return status(s,clientId);
  }
  function invalidate(s,c){
    if(c.readinessProof&&!valid(s,c)){
      const p=active(s,c.clientId);if(p)p.probeDemand=true;
      delete c.readinessPriorityAt;
      // Stale proof is retained for session reuse, never for business admission.
      // The round idle timer remains independent and ends unused refresh cycles.
      if(idleRefresh(s,c))return;
      delete c.readinessProof;
    }
  }
  function record(s,c,r,o){
    const p=active(s,c.clientId);
    if(r.purpose!=='readiness_probe'){
      if(valid(s,c)&&['succeeded','not_found'].includes(o.result?.status)&&!o.human&&!o.recovery&&!o.unknown&&!o.stopped)c.readinessProof.lastSuccessAt=now();
      return;
    }
    const id=identity(c);
    if(p&&r.preparationId===p.preparationId&&o.result?.status==='succeeded'&&String(o.result.name||'').trim()&&id&&!o.accountOffline&&!o.human&&!o.recovery&&!o.unknown&&!o.stopped){
      clearAccountOffline(s,c);
      recordLookupPreparationSuccess(s,c);
      const device=s.devices.find(d=>d.deviceId===c.deviceId);
      if(device)device.lastReadinessSuccessAt=now();
      c.readinessProof={owner,preparationId:p.preparationId,generation:c.generation,sessionId:c.sessionId,identity:id,verifiedAt:now(),lastSuccessAt:now()};
      rememberAdmission(s,p);
      if(c.humanResumePending){c.readinessPriorityAt=now();delete c.humanResumePending;}
      if(s.channels.filter(x=>x.clientId===c.clientId&&valid(s,x)).length>=targetCount(s))p.probeDemand=false;
    }else{delete c.readinessProof;recordLookupPreparationFailure(s,c,r,now(),{domain:'page',code:'lookup_probe_result_mismatch'});}
  }
  function newProbe(s,c,p){
    delete c.readinessProof;delete c.readinessPriorityAt;
    const id=crypto.randomUUID(),r={lookupId:id,clientId:c.clientId,purpose:'readiness_probe',preparationId:p.preparationId,idempotencyKey:'probe-'+id,fingerprint:crypto.createHash('sha256').update(probePhone).digest('hex'),phoneNumber:probePhone,consentReference:s.grants.find(g=>g.clientId===c.clientId)?.consentReference,createdAt:new Date(now()).toISOString(),deadline:now()+1800000,executionDeadline:now()+1800000,mode:'async',status:'queued',attempts:[],name:''};
    const device=s.devices.find(d=>d.deviceId===c.deviceId);
    if(pagePreparationRetryAt(s,device,p.clientId)!==null){
      r.pageReprobe=true;p.lastPageReprobeAt=now();
    }
    s.requests.push(r);p.probeAttempts=p.probeAttempts.filter(a=>a.at>now()-60000);p.probeAttempts.push({deviceId:c.deviceId,at:now(),lookupId:id});c.requestId=id;c.preparationId=p.preparationId;return r;
  }
  // Working capacity and retained idle sessions are separate budgets. A phone
  // waiting for human/unknown execution cannot be retired to satisfy this cap.
  // Pin ongoing work, then keep recently recovered and fresh idle sessions.
  function surplus(s){
    const result=[],target=targetCount(s);
    for(const p of s.preparations||[]){
      if(!active(s,p.clientId))continue;
      const proven=s.channels.filter(c=>c.clientId===p.clientId&&valid(s,c,{ignoreFreshness:true}));
      const idle=proven.filter(c=>{
        const r=s.requests.find(r=>r.lookupId===c.requestId);
        let o;try{o=adapter.observe(c);}catch{return false;}
        return c.phase==='idle'&&(!r||TERMINAL.has(r.status))&&o.ready===true&&!o.busy;
      });
      const pinned=proven.length-idle.length;
      idle.sort((a,b)=>Number(Number.isFinite(b.readinessPriorityAt))-Number(Number.isFinite(a.readinessPriorityAt))||
        (Number.isFinite(a.readinessPriorityAt)&&Number.isFinite(b.readinessPriorityAt)?a.readinessPriorityAt-b.readinessPriorityAt:0)||
        Number(valid(s,b))-Number(valid(s,a)));
      result.push(...idle.slice(Math.max(0,target-pinned)));
    }
    return result;
  }
  function next(s,excluded=new Set()){
    if(!configured()||!s.config.enabled)return null;
    const retiring=new Set(surplus(s).map(c=>c.deviceId));
    for(const p of s.preparations||[]){
      if(!active(s,p.clientId))continue;
      const probeBudgetFull=p.probeAttempts.filter(a=>a.at>now()-60000).length>=15;
      if(p.probeDemand===false&&!s.requests.some(r=>r.clientId===p.clientId&&r.purpose!=='readiness_probe'&&!TERMINAL.has(r.status)))continue;
      const cs=s.channels.filter(c=>c.clientId===p.clientId);
      const inFlight=cs.filter(c=>{const r=s.requests.find(r=>r.lookupId===c.requestId);return r?.purpose==='readiness_probe'&&!TERMINAL.has(r.status)&&!['human','recovery'].includes(c.phase);}).length;
      if(cs.filter(c=>valid(s,c)).length+inFlight>=targetCount(s))continue;
      // At most one active page re-probe across clients. Human waits use the
      // existing physical reservation budget, but do not stop other recovery.
      const pageRetryBusy=s.channels.some(c=>!['idle','human','recovery','quarantined'].includes(c.phase)&&s.requests.some(r=>r.lookupId===c.requestId&&r.pageReprobe));
      const lastPageRetry=Math.max(0,...s.preparations.map(x=>x.lastPageReprobeAt||0));
      const candidates=[];
      for(const d of s.devices){
        const retryAt=pagePreparationRetryAt(s,d,p.clientId),pageRetry=retryAt!==null;
        if(pageRetry&&(retryAt>now()||pageRetryBusy||lastPageRetry&&now()-lastPageRetry<60000))continue;
        if(adapter.supportsReadiness?.(d.deviceId)===false||!d.enabled||lookupDeviceUnavailable(d)||(preparationBlocked(s,d,p.clientId)&&!pageRetry)||accountOfflineBlocked(s,d,p.clientId)||retiring.has(d.deviceId)||excluded.has(d.deviceId)||d.quarantineUntil>now()||!healthy(d.deviceId))continue;
        const attempts=p.probeAttempts.filter(a=>a.deviceId===d.deviceId&&a.at>now()-60000);
        const repair=d.accountRepairAt>0&&now()-d.accountRepairAt<120000;
        if(!repair&&(attempts.length>=2||attempts.length&&now()-attempts.at(-1).at<30000))continue;
        const c=s.channels.find(c=>c.deviceId===d.deviceId);
        if(probeBudgetFull&&!repair&&!(c&&idleRefresh(s,c)))continue;
        if(c&&(c.clientId!==p.clientId||c.phase!=='idle'||valid(s,c)))continue;
        if(!c&&s.channels.filter(x=>x.phase!=='quarantined').length>=s.config.concurrency)continue;
        candidates.push({p,d,c,repair,pageRetry,retryAt,refresh:Boolean(c&&idleRefresh(s,c)),attempts:attempts.length});
      }
      // Refresh an expired healthy session before opening a substitute.
      // Actual failures still prefer unused substitutes over repeated retries.
      // Existing idle sessions then win ties, followed by least recently used device.
      // Recent success is a selection hint only, never business admission.
      // Every selected phone must still pass a new probe for this round.
      const recentSuccess=d=>Number.isFinite(d.lastReadinessSuccessAt)&&d.lastReadinessSuccessAt<=now()&&now()-d.lastReadinessSuccessAt<86400000;
      candidates.sort((a,b)=>Number(a.pageRetry)-Number(b.pageRetry)||(a.pageRetry&&b.pageRetry?a.retryAt-b.retryAt:0)||Number(b.refresh)-Number(a.refresh)||Number(b.repair)-Number(a.repair)||a.attempts-b.attempts||Number(!a.c)-Number(!b.c)||Number(recentSuccess(b.d))-Number(recentSuccess(a.d))||(a.d.lastUsedAt||0)-(b.d.lastUsedAt||0));
      if(s.devices.some(d=>excluded.has(d.deviceId)&&d.enabled&&d.accountRepairAt>0&&now()-d.accountRepairAt<120000&&healthy(d.deviceId)))continue;
      if(candidates.length)return candidates[0];
    }
    return null;
  }
  return {active,enabled,valid,prepare,status,invalidate,record,newProbe,next,surplus,probePhone,
    keepWarm:(s,c)=>Boolean(active(s,c.clientId)&&(valid(s,c)||idleRefresh(s,c))),
    allowBusiness:(s,c,r)=>r.purpose==='readiness_probe'||r.resultProtocol!==PREPARED_PROTOCOL||valid(s,c),
    submissionFeedback,
    assertAdmission(s,id){if(enabled(s,id)){if(!status(s,id).ready)throw error('lookup_not_ready',503);if(!submissionFeedback(s,id).acceptingRequests)throw Object.assign(error('lookup_no_available_device',503),{retryAfterSeconds:30});}rememberAdmission(s,current(s,id));},
    publicProbeConfigured:configured};
}
