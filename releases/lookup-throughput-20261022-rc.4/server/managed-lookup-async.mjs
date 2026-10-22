import {markRoundBusiness} from './lookup-round-idle.mjs';
import crypto from 'node:crypto';
import {PREPARED_PROTOCOL} from './lookup-readiness.mjs';
const DONE=new Set(['succeeded','not_found','failed','expired','cancelled']);
export const ASYNC_LOOKUP_DEFAULTS=Object.freeze({asyncQueueWaitMs:1800000,asyncTaskTtlMs:3600000,asyncRecentResultMs:600000,asyncAliasLimit:50,preparedClientInflightLimit:20});
const error=(code,status=400)=>Object.assign(new Error(code),{statusCode:status});
const authorize=(s,adapter,clientId)=>{const grant=s.grants.find(g=>g.clientId===clientId&&g.enabled);if(!grant||!adapter.clientValid(clientId))throw error('managed_lookup_not_authorized',403);return grant;};
export async function managedRequestByKey(s,tx,clientId,key){
  const old=s.requests.find(r=>r.clientId===clientId&&r.idempotencyKey===key)||await tx.archived(clientId,key);if(old)return old;
  const alias=tx.alias?await tx.alias(clientId,key):(s.aliases||[]).find(a=>a.clientId===clientId&&a.idempotencyKey===key);if(!alias)return null;
  const r=s.requests.find(r=>r.clientId===clientId&&r.lookupId===alias.lookupId)||await tx.request?.(clientId,alias.lookupId);
  if(!r||r.fingerprint!==alias.fingerprint)throw error('lookup_outcome_unknown',503);return r;
}
export function publicAsyncLookup(r){
  if(r.resultProtocol===PREPARED_PROTOCOL){
    if(['succeeded','not_found'].includes(r.status))return {ok:true,lookupId:r.lookupId,status:'completed',name:r.status==='succeeded'?r.name||'':''};
    if(DONE.has(r.status))return {ok:false,lookupId:r.lookupId,status:'failed',code:r.code||'lookup_service_error'};
    return {ok:true,lookupId:r.lookupId,status:r.status==='queued'?'queued':'processing'};
  }
  const status=r.status==='succeeded'?'succeeded':r.status==='not_found'?'not_found':r.status==='queued'?'queued':DONE.has(r.status)?'failed':'processing';
  const code=r.code||(status==='not_found'?'not_found':r.status==='waiting_human'?'lookup_manual_action_pending':r.status==='unknown'?'lookup_outcome_unknown':r.status==='needs_recovery'?'lookup_recovery_required':status==='failed'?'lookup_execution_failed':'');
  return {ok:true,lookupId:r.lookupId,status,name:status==='succeeded'?r.name||'':'',code};
}
export function createManagedAsyncLookup({store,adapter,now=Date.now,readiness}){
  const config=s=>({...ASYNC_LOOKUP_DEFAULTS,...s.config});
  async function addAlias(s,tx,r,clientId,key,fingerprint){
    const count=tx.aliasCount?await tx.aliasCount(clientId,r.lookupId):(s.aliases||[]).filter(a=>a.clientId===clientId&&a.lookupId===r.lookupId).length;
    if(count>=config(s).asyncAliasLimit)throw error('lookup_duplicate_limit',429);
    const alias={clientId,idempotencyKey:key,fingerprint,lookupId:r.lookupId,createdAt:new Date(now()).toISOString()};
    if(tx.addAlias)await tx.addAlias(alias);else{(s.aliases||=[]).push(alias);}
  }
  return {
    async submit({clientId,phoneNumber,key}){
      if(!key)throw error('idempotency_key_required');if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw error('invalid_idempotency_key');
      return store.transact(async(s,tx)=>{
        const grant=authorize(s,adapter,clientId);const fingerprint=crypto.createHash('sha256').update(phoneNumber).digest('hex');
        const old=await managedRequestByKey(s,tx,clientId,key);
        if(old){if(old.fingerprint!==fingerprint)throw error('idempotency_conflict',409);return {lookupId:old.lookupId,reused:true};}
        if(!s.config.enabled)throw error('lookup_pool_disabled',503);
        const active=s.requests.filter(r=>r.purpose!=='readiness_probe'&&r.clientId===clientId&&r.fingerprint===fingerprint&&(!DONE.has(r.status)||s.channels.some(c=>c.requestId===r.lookupId))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
        let reused=active;
        if(!reused){
          const floor=now()-config(s).asyncRecentResultMs;
          const recent=s.requests.filter(r=>r.purpose!=='readiness_probe'&&r.clientId===clientId&&r.fingerprint===fingerprint&&['succeeded','not_found'].includes(r.status)&&Date.parse(r.completedAt)>floor&&Date.parse(r.completedAt)<=now()).sort((a,b)=>b.completedAt.localeCompare(a.completedAt))[0];
          const archived=await tx.recent?.(clientId,fingerprint,new Date(floor).toISOString(),new Date(now()).toISOString());
          reused=(!recent||archived?.completedAt>recent.completedAt)?archived:recent;
        }
        if(reused){await addAlias(s,tx,reused,clientId,key,fingerprint);return {lookupId:reused.lookupId,reused:true};}
        readiness?.assertAdmission(s,clientId);
        // A prepared caller has a configurable window of canonical unfinished business
        // requests. Probe work and duplicate aliases do not consume this window.
        // Check inside the same transaction as insertion, after all dedup paths.
        if(readiness?.enabled(s,clientId)&&s.requests.filter(r=>r.clientId===clientId&&r.purpose!=='readiness_probe'&&!DONE.has(r.status)).length>=config(s).preparedClientInflightLimit)throw error('lookup_inflight_limit',429);
        const queued=s.requests.filter(r=>r.status==='queued');if(queued.length>=s.config.queueLimit||queued.filter(r=>r.clientId===clientId).length>=s.config.clientQueueLimit)throw error('lookup_queue_full',429);
        const id=crypto.randomUUID(),time=now(),cfg=config(s);s.requests.push({lookupId:id,clientId,idempotencyKey:key,fingerprint,phoneNumber,consentReference:grant.consentReference,createdAt:new Date(time).toISOString(),deadline:time+Math.min(cfg.asyncQueueWaitMs,cfg.asyncTaskTtlMs),executionDeadline:time+cfg.asyncTaskTtlMs,mode:'async',...(readiness?.enabled(s,clientId)?{resultProtocol:PREPARED_PROTOCOL}:{}),status:'queued',attempts:[],name:''});markRoundBusiness(s,clientId);return {lookupId:id,reused:false};
      });
    },
    async result(lookupId,clientId){
      if(store.isFenced())throw error('lookup_storage_unavailable',503);authorize(store.snapshot(),adapter,clientId);const r=await store.readRequest(lookupId,clientId);if(!r||r.purpose==='readiness_probe')throw error('lookup_task_not_found',404);const s=store.snapshot(),prepared=readiness?.enabled(s,clientId),result=publicAsyncLookup(prepared?{...r,resultProtocol:PREPARED_PROTOCOL}:r);const feedback=prepared&&r.status==='queued'?readiness.submissionFeedback(s,clientId):null;return feedback?.code==='lookup_no_available_device'?{...result,...feedback}:result;
    }
  };
}
