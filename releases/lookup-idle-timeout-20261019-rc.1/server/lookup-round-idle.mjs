// A round stays alive while canonical business work is unfinished. Probe work,
// transport retries and polling do not count as new customer activity.
export const ROUND_IDLE_MS=600000;
const DONE=new Set(['succeeded','not_found','failed','expired','cancelled']);
export const hasRoundBusiness=(s,p)=>s.requests.some(r=>r.clientId===p.clientId&&r.purpose!=='readiness_probe'&&!DONE.has(r.status));
export function roundDeadline(s,p,now=Date.now()){
  if(p.stopRequestedAt!==undefined)return p.expiresAt;
  if(hasRoundBusiness(s,p))return null;
  if(p.idlePolicy===1)return p.idleSince===null?now+p.idleTimeoutMs:p.idleSince+p.idleTimeoutMs;
  return p.expiresAt; // A legacy expired idle round is never revived on upgrade.
}
export const roundIsActive=(s,p,now)=>p.stopRequestedAt===undefined&&(roundDeadline(s,p,now)===null||roundDeadline(s,p,now)>now);
export function markRoundBusiness(s,clientId){
  const p=s.preparations?.find(p=>p.clientId===clientId);
  if(p?.idlePolicy===1&&p.stopRequestedAt===undefined){p.idleSince=null;p.expiresAt=null;}
}
export function roundIdleNeedsSync(s,now,idleMs=ROUND_IDLE_MS){
  return (s.preparations||[]).some(p=>p.stopRequestedAt===undefined&&(p.idlePolicy!==1||
    (hasRoundBusiness(s,p)?p.idleSince!==null:p.idleSince===null||roundDeadline(s,p,now)<=now)));
}
export function syncRoundIdle(s,now,idleMs,stop){
  for(const p of s.preparations||[]){
    if(p.stopRequestedAt!==undefined)continue;
    const busy=hasRoundBusiness(s,p);
    if(p.idlePolicy!==1){
      if(!busy&&p.expiresAt<=now){stop(p);continue;}
      p.idlePolicy=1;p.idleTimeoutMs=idleMs;p.idleSince=busy?null:now;
    }
    if(busy){p.idleSince=null;p.expiresAt=null;continue;}
    if(p.idleSince===null)p.idleSince=now;
    p.expiresAt=p.idleSince+p.idleTimeoutMs;
    if(now>=p.expiresAt)stop(p);
  }
}
