import {lookupDeviceUnavailable,recordLookupPreparationFailure,recordLookupPreparationSuccess} from './lookup-device-availability.mjs';
import crypto from 'node:crypto';
export const PREPARED_PROTOCOL='prepared-v1';
// Local freshness policy, not a guarantee about the upstream verification timer.
export const READINESS_IDLE_TTL_MS=240000;
const TERMINAL=new Set(['succeeded','not_found','failed','cancelled','expired']);
const error=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export function createLookupReadiness({adapter,now=Date.now,probePhone='',leaseMs=1800000}){
  const owner=crypto.randomUUID();
  const configured=()=>/^1[3-9]\d{9}$/.test(probePhone);
  const current=(s,id)=>(s.preparations||[]).find(p=>p.clientId===id);
  const active=(s,id)=>{const p=current(s,id);return s.config.enabled&&p&&p.expiresAt>now()&&s.grants.some(g=>g.clientId===id&&g.enabled)&&adapter.clientValid(id)?p:null;};
  const identity=c=>{try{return adapter.readinessIdentity?.(c)||'';}catch{return '';}};
  const healthy=id=>{try{return adapter.health(id).ready;}catch{return false;}};
  function valid(s,c,{ignoreFreshness=false}={}){
    const p=active(s,c.clientId),proof=c.readinessProof;
    if(!p||!proof||proof.owner!==owner||proof.preparationId!==p.preparationId||proof.generation!==c.generation||proof.sessionId!==c.sessionId||!identity(c)||proof.identity!==identity(c)||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled&&!lookupDeviceUnavailable(d))||!healthy(c.deviceId))return false;
    const lastSuccess=proof.lastSuccessAt??proof.verifiedAt;
    if(!ignoreFreshness&&c.phase==='idle'&&(!Number.isFinite(lastSuccess)||now()<lastSuccess||now()-lastSuccess>=READINESS_IDLE_TTL_MS))return false;
    let o;try{o=adapter.observe(c);}catch{return false;}return !o.human&&!o.recovery&&!o.unknown&&!o.switching&&!o.stopped&&!o.exhausted&&!o.startFailed&&(o.busy||o.ready!==false)&&c.phase!=='stopping';
  }
  const enabled=(s,id)=>Boolean(current(s,id));
  function status(s,id){
    const p=current(s,id),a=active(s,id),cs=s.channels.filter(c=>c.clientId===id&&valid(s,c));
    return {ok:true,preparationId:p?.preparationId||'',status:!a?'expired':cs.length>=2?'ready':'preparing',ready:Boolean(a&&cs.length>=2),readyCount:cs.length,idleCount:cs.filter(c=>c.phase==='idle').length,minimumReady:2,targetCount:5,expiresAt:p?new Date(p.expiresAt).toISOString():null};
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
    if(old){const a=active(s,clientId);if(a)a.probeDemand=status(s,clientId).readyCount<5;return status(s,clientId);}
    if(s.preparationKeys.filter(k=>k.clientId===clientId).length>=1000)throw error('lookup_preparation_key_limit',429);
    let a=active(s,clientId);
    if(!a){a={preparationId:crypto.randomUUID(),clientId,createdAt:now(),expiresAt:now()+leaseMs,probeAttempts:[]};if(p)s.preparations.splice(s.preparations.indexOf(p),1);s.preparations.push(a);}
    a.probeDemand=status(s,clientId).readyCount<5;
    s.preparationKeys.push({clientId,key,preparationId:a.preparationId});return status(s,clientId);
  }
  function invalidate(s,c){
    if(c.readinessProof&&!valid(s,c)){
      // Repair actual failures automatically. Idle expiry alone waits for demand,
      // rather than spending probe queries indefinitely to keep an unused pool warm.
      const p=active(s,c.clientId);if(p&&!valid(s,c,{ignoreFreshness:true}))p.probeDemand=true;
      delete c.readinessProof;delete c.readinessPriorityAt;
    }
  }
  function record(s,c,r,o){
    const p=active(s,c.clientId);
    if(r.purpose!=='readiness_probe'){
      if(valid(s,c)&&['succeeded','not_found'].includes(o.result?.status)&&!o.human&&!o.recovery&&!o.unknown&&!o.stopped)c.readinessProof.lastSuccessAt=now();
      return;
    }
    const id=identity(c);
    if(p&&r.preparationId===p.preparationId&&o.result?.status==='succeeded'&&String(o.result.name||'').trim()&&id&&!o.human&&!o.recovery&&!o.unknown&&!o.stopped){
      recordLookupPreparationSuccess(s,c);
      c.readinessProof={owner,preparationId:p.preparationId,generation:c.generation,sessionId:c.sessionId,identity:id,verifiedAt:now(),lastSuccessAt:now()};
      if(c.humanResumePending){c.readinessPriorityAt=now();delete c.humanResumePending;}
      if(s.channels.filter(x=>x.clientId===c.clientId&&valid(s,x)).length>=5)p.probeDemand=false;
    }else{delete c.readinessProof;recordLookupPreparationFailure(s,c,r,now());}
  }
  function newProbe(s,c,p){
    const id=crypto.randomUUID(),r={lookupId:id,clientId:c.clientId,purpose:'readiness_probe',preparationId:p.preparationId,idempotencyKey:'probe-'+id,fingerprint:crypto.createHash('sha256').update(probePhone).digest('hex'),phoneNumber:probePhone,consentReference:s.grants.find(g=>g.clientId===c.clientId)?.consentReference,createdAt:new Date(now()).toISOString(),deadline:p.expiresAt,executionDeadline:p.expiresAt,mode:'async',status:'queued',attempts:[],name:''};
    s.requests.push(r);p.probeAttempts=p.probeAttempts.filter(a=>a.at>now()-60000);p.probeAttempts.push({deviceId:c.deviceId,at:now(),lookupId:id});c.requestId=id;c.preparationId=p.preparationId;return r;
  }
  function next(s,excluded=new Set()){
    if(!configured()||!s.config.enabled)return null;
    for(const p of s.preparations||[]){
      if(!active(s,p.clientId)||p.probeAttempts.filter(a=>a.at>now()-60000).length>=15)continue;
      if(p.probeDemand===false&&!s.requests.some(r=>r.clientId===p.clientId&&r.purpose!=='readiness_probe'&&!TERMINAL.has(r.status)))continue;
      const cs=s.channels.filter(c=>c.clientId===p.clientId);
      const inFlight=cs.filter(c=>{const r=s.requests.find(r=>r.lookupId===c.requestId);return r?.purpose==='readiness_probe'&&!TERMINAL.has(r.status)&&!['human','recovery'].includes(c.phase);}).length;
      if(cs.filter(c=>valid(s,c)).length+inFlight>=5)continue;
      const candidates=[];
      for(const d of s.devices){
        if(adapter.supportsReadiness?.(d.deviceId)===false||!d.enabled||lookupDeviceUnavailable(d)||excluded.has(d.deviceId)||d.quarantineUntil>now()||!healthy(d.deviceId))continue;
        const attempts=p.probeAttempts.filter(a=>a.deviceId===d.deviceId&&a.at>now()-60000);
        if(attempts.length>=2||attempts.length&&now()-attempts.at(-1).at<30000)continue;
        const c=s.channels.find(c=>c.deviceId===d.deviceId);
        if(c&&(c.clientId!==p.clientId||c.phase!=='idle'||valid(s,c)))continue;
        candidates.push({p,d,c,attempts:attempts.length});
      }
      // Try unused healthy substitutes before retrying a repeatedly failing phone.
      // Existing idle sessions then win ties, followed by least recently used device.
      candidates.sort((a,b)=>a.attempts-b.attempts||Number(!a.c)-Number(!b.c)||(a.d.lastUsedAt||0)-(b.d.lastUsedAt||0));
      if(candidates.length)return candidates[0];
    }
    return null;
  }
  return {active,enabled,valid,prepare,status,invalidate,record,newProbe,next,probePhone,
    keepWarm:(s,c)=>Boolean(active(s,c.clientId)&&valid(s,c)),
    allowBusiness:(s,c,r)=>r.purpose==='readiness_probe'||r.resultProtocol!==PREPARED_PROTOCOL||valid(s,c),
    assertAdmission(s,id){if(enabled(s,id)&&!status(s,id).ready)throw error('lookup_not_ready',503);},
    publicProbeConfigured:configured};
}
