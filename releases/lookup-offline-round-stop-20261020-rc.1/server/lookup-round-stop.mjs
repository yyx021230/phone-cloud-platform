const TERMINAL=new Set(['succeeded','not_found','failed','expired','cancelled']);
export const ROUND_STOP_OFFLINE_GRACE_MS=30000;
const fail=(code,statusCode=400)=>Object.assign(new Error(code),{statusCode});
export const roundStopRequested=(s,clientId)=>s.preparations?.find(p=>p.clientId===clientId)?.stopRequestedAt!==undefined;
export const roundStopping=(s,clientId)=>Boolean(s.roundStops?.some(r=>r.clientId===clientId&&r.status==='stopping'));
const response=r=>({ok:true,preparationId:r.preparationId,status:r.status,stopped:r.status==='stopped'});

export function settleRoundStops(s,now=Date.now){
  for(const r of s.roundStops||[]){
    if(r.status!=='stopping')continue;
    // A durable cancellation fence ends this caller's round, not the physical
    // reservation. Detached phones remain unavailable until cleanup ACK.
    const bound=s.channels.some(c=>c.clientId===r.clientId&&c.roundStopPreparationId===r.preparationId&&c.roundStopDetachedAt===undefined);
    const unfinished=s.requests.some(q=>r.requestIds.includes(q.lookupId)&&!TERMINAL.has(q.status));
    if(bound||unfinished)continue;
    r.status='stopped';r.completedAt=new Date(now()).toISOString();
    const p=s.preparations?.find(p=>p.clientId===r.clientId&&p.preparationId===r.preparationId);
    if(p)p.stoppedAt=now();
  }
}

// The preparation ID fences a delayed old stop from a later start. The key
// makes transport retries stable; neither operation can create a new round.
export function requestRoundStop(s,{clientId,preparationId,key},{adapter,now=Date.now,finish,audit}){
  if(!s.grants.some(g=>g.clientId===clientId&&g.enabled)||!adapter.clientValid(clientId))throw fail('managed_lookup_not_authorized',403);
  if(!/^[A-Za-z0-9._:-]{8,160}$/.test(key||''))throw fail('invalid_idempotency_key');
  if(!/^[A-Za-z0-9-]{1,80}$/.test(preparationId||''))throw fail('invalid_preparation_id');
  s.roundStops||=[];
  const prior=s.roundStops.find(r=>r.clientId===clientId&&r.keys.includes(key));
  if(prior&&prior.preparationId!==preparationId)throw fail('idempotency_conflict',409);
  let record=s.roundStops.find(r=>r.clientId===clientId&&r.preparationId===preparationId);
  if(!prior&&s.roundStops.filter(r=>r.clientId===clientId).reduce((n,r)=>n+r.keys.length,0)>=1000)throw fail('lookup_stop_key_limit',429);
  if(record){if(!prior)record.keys.push(key);settleRoundStops(s,now);return response(record);}
  const p=s.preparations?.find(p=>p.clientId===clientId&&p.preparationId===preparationId);
  if(!p)throw fail('lookup_preparation_not_found',404);
  return beginRoundStop(s,p,{now,finish,audit},[key]);
}

// Internal idle expiry uses the same ACK barrier but does not consume user keys
// or depend on credentials that may have been revoked since preparation.
export function expireIdleRound(s,p,options){
  const record=s.roundStops?.find(r=>r.clientId===p.clientId&&r.preparationId===p.preparationId);
  if(record)return response(record);
  p.autoStopReason='idle_timeout';
  return beginRoundStop(s,p,options,[]);
}
function beginRoundStop(s,p,{now,finish,audit},keys){
  const {clientId,preparationId}=p;s.roundStops||=[];
  p.stopRequestedAt=now();p.probeDemand=false;p.stopPreviousExpiresAt=p.expiresAt;p.expiresAt=Math.min(p.expiresAt??now(),now());
  const record={clientId,preparationId,keys,status:'stopping',requestedAt:new Date(now()).toISOString(),requestIds:[]};s.roundStops.push(record);
  // One caller owns one current preparation. Include any still-unfinished
  // accepted work from its expired lease, but never another caller's work.
  for(const r of s.requests.filter(r=>r.clientId===clientId&&!TERMINAL.has(r.status))){
    record.requestIds.push(r.lookupId);
    const bound=s.channels.some(c=>c.requestId===r.lookupId);
    if(r.status==='queued'&&!bound)finish(r,'cancelled','lookup_round_stopped');
    else{r.cancelRequested=true;r.cancelReason='lookup_round_stopped';r.status='cancelling';}
  }
  for(const c of s.channels.filter(c=>c.clientId===clientId&&c.roundStopDetachedAt===undefined)){
    c.roundStopPreparationId=preparationId;delete c.readinessProof;delete c.readinessPriorityAt;delete c.rerouteAfterStop;delete c.rerouteReason;
  }
  audit(s,'lookup_round_stop',clientId,{preparationId});settleRoundStops(s,now);return response(record);
}
