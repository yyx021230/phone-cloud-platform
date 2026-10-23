import {lookupFailureDomain} from './lookup-failure-domain.mjs';
// Only evidenced transport/executor failures trip the persistent circuit.
// Page preparation failures have backoff plus paced re-probing. Unknown
// failures retain the per-round block; neither becomes hardware isolation.
export const LOOKUP_FAILURE_LIMIT=3;
export const lookupDeviceUnavailable=d=>d?.lookupUnavailable===true;
export function preparationBlocked(s,d,clientId){
  const p=s.preparations?.find(p=>p.clientId===clientId);
  return Boolean(p&&p.stopRequestedAt===undefined&&d?.preparationIssue?.rounds?.some(x=>x.clientId===clientId&&x.preparationId===p.preparationId&&x.count>=2));
}
// A retry deadline is not a readiness proof. Keep preparationBlocked true
// until a fresh named probe succeeds; only the scheduler may use this escape.
export function pagePreparationRetryAt(s,d,clientId){
  if(!preparationBlocked(s,d,clientId)||d.preparationIssue?.domain!=='page')return null;
  const issue=d.preparationIssue;
  if(Number.isFinite(issue.retryAt))return issue.retryAt;
  // Deployed records have count=2 and no retryAt. Recover them lazily without
  // clearing login/cooldown/device state or rewriting production records.
  return Number.isFinite(issue.at)?issue.at+300000:null;
}
export function preparationFailureEvidence(job){
  if(!job||job.status!=='failed'||!['alipay_name_start','alipay_name_query'].includes(job.kind))return null;
  const code=String(job.result?.errorCode||'');
  const domain=lookupFailureDomain(job)||(['alipay_account_identity_unverified','alipay_page_element_changed','alipay_ui_hierarchy_unavailable'].includes(code)?'page':'unknown');
  return {jobId:job.jobId,domain,code};
}
export function recordLookupPreparationFailure(s,c,r,now,evidence){
  const d=s.devices.find(d=>d.deviceId===c.deviceId);
  if(!d||!r||r.availabilityFailureRecorded)return;
  r.availabilityFailureRecorded=true;
  const domain=evidence?.domain||'unknown';
  d.lastPreparationFailure={domain,code:evidence?.code||'lookup_probe_failed',jobId:evidence?.jobId||'',at:now};
  if(domain!=='device'){
    const rounds=(d.preparationIssue?.rounds||[]).filter(x=>s.preparations?.some(p=>p.clientId===x.clientId&&p.preparationId===x.preparationId));
    const p=s.preparations?.find(p=>p.clientId===c.clientId);
    if(p){let row=rounds.find(x=>x.clientId===c.clientId&&x.preparationId===p.preparationId);if(!row){row={clientId:c.clientId,preparationId:p.preparationId,count:0};rounds.push(row);}row.count=Math.min(domain==='page'?3:2,row.count+1);}
    const count=rounds.find(x=>x.clientId===c.clientId&&x.preparationId===p?.preparationId)?.count||1;
    const delay=domain==='page'?[60000,300000,900000][Math.min(3,count)-1]:60000;
    d.preparationIssue={...d.lastPreparationFailure,rounds,...(domain==='page'?{retryAt:now+delay}:{})};
    d.quarantineUntil=Math.max(d.quarantineUntil||0,now+delay);
    return;
  }
  d.prepareFailureCount=Math.min(LOOKUP_FAILURE_LIMIT,(d.prepareFailureCount||0)+1);
  d.quarantineUntil=Math.max(d.quarantineUntil||0,now+[30000,60000,120000][d.prepareFailureCount-1]);
  if(d.prepareFailureCount>=LOOKUP_FAILURE_LIMIT){d.lookupUnavailable=true;d.lookupUnavailableAt=now;}
}
export function recordLookupPreparationSuccess(s,c){
  const d=s.devices.find(d=>d.deviceId===c.deviceId);
  // A late result cannot release a persistent operator-visible circuit.
  if(d&&!lookupDeviceUnavailable(d)){d.prepareFailureCount=0;d.quarantineUntil=0;delete d.preparationIssue;delete d.lastPreparationFailure;}
}
export function resetLookupUnavailable(d){
  d.prepareFailureCount=0;d.quarantineUntil=0;d.lookupUnavailable=false;delete d.lookupUnavailableAt;delete d.preparationIssue;delete d.lastPreparationFailure;
}
