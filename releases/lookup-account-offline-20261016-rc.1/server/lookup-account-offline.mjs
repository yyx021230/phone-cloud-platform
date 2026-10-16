import crypto from 'node:crypto';

const LOGIN_ACTIVITY=/com\.eg\.android\.AlipayGphone\/com\.ali\.user\.mobile\.loginupgrade\.activity\.LoginActivity(?:$|\s|[}])|^com\.ali\.user\.mobile\.loginupgrade\.activity\.LoginActivity$/;
const WORK=new Set(['alipay_name_start','alipay_name_query','alipay_name_switch']);
export function accountLabel(value) {
  const s=String(value||'').trim().replace(/\s+/g,'');
  if(/^1\d{10}$/.test(s))return s.slice(0,3)+'******'+s.slice(-2);
  if(/^1\d{2}\*{3,8}\d{2,4}$/.test(s))return s;
  if(/^[A-Za-z0-9.*_+-]{1,64}@[A-Za-z0-9.-]{1,100}$/.test(s)){
    const [local,domain]=s.split('@');return local.slice(0,1)+'***@'+domain;
  }
  return '';
}
// Classify a terminal observation, never a timeout, a saved-account picker,
// the normal .AlipayLogin launcher, or a historical failure on a live task.
export function lookupAccountOfflineEvidence(job,session={}) {
  if(!job||job.status!=='failed'||!WORK.has(job.kind))return null;
  const r=job.result||{},d=r.diagnostic||{};
  const explicit=[r.errorCode,r.error,d.code,d.runnerReason].some(x=>/^(?:poco_)?alipay_login_required(?:$|:)/.test(String(x||'')));
  if(!explicit&&!LOGIN_ACTIVITY.test(String(r.currentActivity||'')))return null;
  const selected=[...(job.events||[])].reverse().find(e=>e.stepId==='account_selected'&&e.detail?.toAccount);
  const target=selected?.detail?.toAccount||d.accountSwitchHistory?.at(-1)?.toAccount;
  const current=r.currentAccount||d.currentAccount;
  // A stale previous account must never override an actual selected target.
  const account=target?accountLabel(target):accountLabel(current)||accountLabel(session.currentAccount);
  const verified=r.accountIdentityVerified===true||d.accountIdentityVerified===true;
  return {jobId:job.jobId,account,accountSource:!account?'unknown':target?'selected_target':accountLabel(current)&&verified?'runner_current':'last_confirmed',detectedAt:job.completedAt||job.updatedAt||'',reason:'account_login_required'};
}
export function latestAccountWork(jobs,sessionId) {
  return jobs.filter(j=>j.sessionId===sessionId&&WORK.has(j.kind)).reverse().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
}
const epoch=p=>p.loginEpoch||p.preparationId;
export function accountOfflineBlocked(s,d,clientId) {
  if(!d?.accountOffline)return false;
  const p=s.preparations?.find(p=>p.clientId===clientId);
  if(!p)return true;
  return d.accountOffline.blockedRounds.some(x=>x.clientId===clientId&&x.preparationId===p.preparationId&&x.epoch===epoch(p));
}
export function recordAccountOffline(s,c,evidence,now) {
  const d=s.devices.find(d=>d.deviceId===c.deviceId);if(!d)return;
  if(d.accountOffline?.jobId===evidence.jobId)return;
  const old=d.accountOffline;
  d.accountOffline={...evidence,detectedAt:evidence.detectedAt||new Date(now).toISOString(),
    notificationId:old&&old.account===evidence.account?old.notificationId:crypto.randomUUID(),
    blockedRounds:(s.preparations||[]).map(p=>({clientId:p.clientId,preparationId:p.preparationId,epoch:epoch(p)}))};
  delete c.readinessProof;delete c.readinessPriorityAt;
  for(const p of s.preparations||[])p.probeDemand=true;
}
export function clearAccountOffline(s,c) {
  const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)delete d.accountOffline;
}
export function pendingAccountOfflineNotifications(pool={},devices=[]) {
  const numbers=new Map(devices.map(d=>[d.deviceId,String(d.deviceName||'').trim()]));
  return (pool.devices||[]).flatMap(d=>{
    const e=d.accountOffline,n=numbers.get(d.deviceId);
    if(!e?.notificationId||!/^\d{1,6}$/.test(n||''))return [];
    const label=accountLabel(e.account);
    const account=label?(e.accountSource==='last_confirmed'?`最近确认账号${label}（当前登录页账号未确认）`:`账号${label}`):'当前登录页账号未能识别';
    return [{key:crypto.createHash('sha256').update('lookup-account-offline:'+d.deviceId+':'+e.notificationId).digest('hex'),kind:'account_offline',deviceName:`${n}号手机`,accountDescription:account}];
  });
}
