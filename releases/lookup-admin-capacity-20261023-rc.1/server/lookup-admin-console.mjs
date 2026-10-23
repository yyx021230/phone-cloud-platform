import {buildLookupCardStatus} from './device-occupancy.mjs';
import {publicLookupAccountCooldowns,verifiedSavedAccounts} from './lookup-account-cooldown.mjs';
const list=v=>Array.isArray(v)?v:[];
const text=v=>String(v??'').slice(0,240);
const date=v=>Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const latest=rows=>[...rows].sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')))[0];
export const lookupJob=j=>/^alipay_name_(start|query|switch|stop)$/.test(j?.kind||'');
export function requestSummary(r){return {lookupId:r.lookupId,clientId:r.clientId,phoneNumber:text(r.phoneNumber),status:r.status,name:['succeeded','not_found'].includes(r.status)?text(r.name):null,code:text(r.code),createdAt:r.createdAt,completedAt:r.completedAt||null,attemptCount:list(r.attempts).length};}
export function buildLookupAdminOverview({pool,state,isReady=()=>false,now=Date.now()}){
 const jobs=list(state.automationJobs).filter(lookupJob),sessions=list(state.automationSessions);
 const devices=list(pool.devices).map(d=>{
  const physical=list(state.devices).find(x=>x.deviceId===d.deviceId),channel=d.channel;
  const history=sessions.filter(s=>s.deviceId===d.deviceId),current=channel?history.find(s=>s.sessionId===channel.sessionId):null;
  const last=current||latest(history),accountSession=latest(history.filter(s=>verifiedSavedAccounts(s.savedAccounts)));
  const saved=verifiedSavedAccounts(accountSession?.savedAccounts)||[],cooldowns=publicLookupAccountCooldowns(physical,now);
  const labels=[...new Set([...saved.map(a=>a.account),...cooldowns.map(a=>a.account),...(last?.currentAccount?[last.currentAccount]:[]),...(d.accountOffline?.account?[d.accountOffline.account]:[])])];
  const card=current?buildLookupCardStatus(current,channel,jobs):null,ready=Boolean(channel&&isReady(channel));
  const deviceJobs=jobs.filter(j=>j.deviceId===d.deviceId),failure=latest(deviceJobs.filter(j=>j.status==='failed'));
  const failureSummary=j=>j?{jobId:j.jobId,at:j.completedAt||j.updatedAt||j.createdAt,code:text(j.result?.errorCode),hasScreenshot:jobEvidence(state,j).length>0}:null;
  const accounts=labels.map(account=>{
   const cooldown=cooldowns.find(c=>c.account===account),isCurrent=Boolean(current?.accountIdentityVerified&&current.currentAccount===account);
   let status='unprobed',reason='需要重新探测才能确认可查';
   if(cooldown?.cooling){status='cooling';reason=cooldown.reason;}
   else if(d.accountOffline?.account===account){status='login_required';reason='账号掉线，本轮不分配；登录后下次启动重新探测';}
   else if(isCurrent&&card?.needsHuman){status=card.state;reason=card.hint;}
   else if(isCurrent&&ready){status='ready';reason='当前账号探测资格有效';}
   else if(isCurrent&&card?.state==='idle'){reason='待重新探测或恢复设备条件，当前不能按就绪分配';}
   else if(isCurrent&&card){status=card.state;reason=card.hint;}
   else if(cooldown){reason='冷却已到期，仍需探测通过';}
   return {account:text(account),status,reason,identity:isCurrent?'current_verified':last?.currentAccount===account?'last_confirmed':'saved',observedAt:date(isCurrent?current.updatedAt:saved.some(a=>a.account===account)?accountSession?.updatedAt:cooldown?.limitedAt||last?.updatedAt),cooldown:cooldown||null,lastFailure:failureSummary(latest(deviceJobs.filter(j=>j.status==='failed'&&(j.result?.currentAccount||j.result?.diagnostic?.currentAccount)===account)))};
  });
  return {deviceId:d.deviceId,deviceNumber:d.deviceNumber,enabled:d.enabled,health:d.health,ready,phase:channel?.phase||null,card,sessionId:channel?.sessionId||null,queryId:channel?.queryId||null,requestId:channel?.requestId||null,observedAt:date(current?.updatedAt),humanObservedAt:channel?.humanObservation?.at||null,accounts,accountsKnown:saved.length>0,accountListObservedAt:date(accountSession?.updatedAt),lastFailure:failureSummary(failure)};
 }).sort((a,b)=>Number(a.deviceNumber)-Number(b.deviceNumber));
 const requests=list(pool.requests).filter(r=>r.purpose!=='readiness_probe');
 return {asOf:new Date(now).toISOString(),revision:pool.revision,enabled:pool.config.enabled,concurrency:pool.config.concurrency,devices,
  counts:{registered:devices.length,available:devices.filter(d=>d.enabled&&d.health?.ready).length,unavailable:devices.filter(d=>d.enabled&&!d.health?.ready).length,probing:devices.filter(d=>d.phase&&list(pool.requests).some(r=>r.lookupId===d.requestId&&r.purpose==='readiness_probe'&&!r.completedAt)).length,enabled:devices.filter(d=>d.enabled).length,occupied:devices.filter(d=>d.phase).length,ready:devices.filter(d=>d.ready).length,human:devices.filter(d=>d.card?.needsHuman).length,queued:requests.filter(r=>r.status==='queued').length,running:requests.filter(r=>!r.completedAt&&r.status!=='queued').length},
  rounds:list(pool.preparations).map(p=>({preparationId:p.preparationId,clientId:p.clientId,createdAt:p.createdAt,admissionOpenedAt:p.admissionOpenedAt??null,stopRequestedAt:p.stopRequestedAt??null,stoppedAt:p.stoppedAt??null,idleSince:p.idleSince??null,idleTimeoutMs:p.idleTimeoutMs??null}))};
}
// Only persisted screenshots belonging to this exact task. No URL/path supplied
// by an Agent or a different task may be turned into an admin evidence link.
export function jobEvidence(state,job){
 if(!lookupJob(job)||!job.windowsTaskId)return [];
 const task=list(state.windowsTasks).find(t=>t.taskId===job.windowsTaskId&&t.deviceId===job.deviceId);
 if(!task)return [];
 const refs=[task.result?.screenshot,job.result?.screenshot,...list(task.events).map(e=>e.screenshot),...list(job.events).map(e=>e.screenshot)].filter(Boolean);
 const seen=new Set();return refs.flatMap(s=>{
  const a=list(state.evidenceAssets).find(a=>a.evidenceId===s.evidenceId&&a.taskId===task.taskId&&a.kind==='screenshot'&&/^image\/(png|jpeg|webp)$/.test(a.mimeType));
  if(!a||seen.has(a.evidenceId))return [];seen.add(a.evidenceId);
  return [{evidenceId:a.evidenceId,capturedAt:date(s.capturedAt||s.createdAt),storedAt:a.createdAt,mimeType:a.mimeType,url:`/api/v1/admin/lookup-pool/console/jobs/${encodeURIComponent(job.jobId)}/evidence/${encodeURIComponent(a.evidenceId)}`}];
 });
}
export function jobDetail(state,job){
 const task=list(state.windowsTasks).find(t=>t.taskId===job.windowsTaskId&&t.deviceId===job.deviceId);
 return {jobId:job.jobId,sessionId:job.sessionId,deviceId:job.deviceId,deviceNumber:list(state.devices).find(d=>d.deviceId===job.deviceId)?.deviceName||'',kind:job.kind,status:job.status,createdAt:job.createdAt,completedAt:job.completedAt||null,account:text(job.result?.currentAccount||job.result?.diagnostic?.currentAccount),code:text(job.result?.errorCode),reason:text(job.result?.diagnostic?.runnerReason||job.result?.diagnostic?.reason),evidence:jobEvidence(state,job),events:list(task?.events).slice(-100).map(e=>({at:e.createdAt||e.at||null,step:text(e.stepId),phase:text(e.phase),message:text(e.message)}))};
}
export function requestDetail(state,r){
 const attempts=list(r.attempts).map(a=>({deviceId:a.deviceId,deviceNumber:list(state.devices).find(d=>d.deviceId===a.deviceId)?.deviceName||'',sessionId:a.sessionId,at:a.at,jobs:list(state.automationJobs).filter(j=>lookupJob(j)&&j.deviceId===a.deviceId&&j.sessionId===a.sessionId&&j.clientReference===r.lookupId).map(j=>jobDetail(state,j))}));
 return {...requestSummary(r),attempts};
}
export function parseLookupCursor(raw){
 if(!raw)return null;
 try{if(raw.length>500)throw Error();const c=JSON.parse(Buffer.from(raw,'base64url').toString());if(!date(c.createdAt)||! /^[A-Za-z0-9-]{1,80}$/.test(c.lookupId))throw Error();return {createdAt:date(c.createdAt),lookupId:c.lookupId};}catch{throw Object.assign(new Error('invalid_cursor'),{statusCode:400});}
}
export function lookupRequestPage(rows,cursor,limit=30){
 const eligible=rows.filter(r=>r.purpose!=='readiness_probe'&&(!cursor||r.createdAt<cursor.createdAt||r.createdAt===cursor.createdAt&&r.lookupId<cursor.lookupId));
 const unique=[...new Map(eligible.map(r=>[r.lookupId,r])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||(a.lookupId<b.lookupId?1:a.lookupId>b.lookupId?-1:0));
 const page=unique.slice(0,limit),last=page.at(-1);
 return {requests:page.map(requestSummary),nextCursor:unique.length>limit?Buffer.from(JSON.stringify({createdAt:last.createdAt,lookupId:last.lookupId})).toString('base64url'):null};
}
