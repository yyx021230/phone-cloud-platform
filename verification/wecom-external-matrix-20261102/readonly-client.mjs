// Approved production READ-ONLY API inventory; explicit --collect invocation.
// Only normal auth login may POST. No phone submission, claim or cleanup route.
import {createHash} from 'node:crypto';
const origin='http://47.98.127.132';
const numbers=['23','25','43','59','93','145','155','157'];
const safe=value=>String(value??'').replace(/[\x00-\x1f\x7f]/g,'').replace(/1[3-9]\d{9}/g,'[redacted]').slice(0,120);
const code=value=>/^[a-z0-9_]{0,100}$/.test(value||'')?value:'unrecognized_code';
export function allowedRequest(method,route,body){
  if(method==='POST')return route==='/api/v1/auth/login'&&body&&Object.keys(body).length===2
    &&typeof body.username==='string'&&typeof body.password==='string';
  return method==='GET'&&(
    ['/api/v1/wecom/devices','/api/v1/wecom/devices?onlineOnly=true','/api/v1/wecom/devices?onlineOnly=invalid',
      '/api/v1/admin/lookup-pool','/api/v1/user/automation/wecom-preview-devices','/api/v1/user/automation/wecom-preview-tasks'].includes(route)
    ||/^\/api\/v1\/(?:wecom\/customer-invitations|user\/automation\/wecom-preview-tasks)\/[a-f0-9-]{36}$/.test(route));
}
export function projectDevice(device){
  return {number:safe(device.deviceNumber),brand:safe(device.brand),model:safe(device.model),androidVersion:safe(device.androidVersion),
    online:device.online===true,adbOnline:device.adbOnline===true,agentOnline:device.agentOnline===true,listed:device.listed===true,
    busy:device.busy===true,busyReason:safe(device.busyReason),occupancy:device.occupancy?{type:code(device.occupancy.type),label:safe(device.occupancy.label)}:null,
    wecomAllowed:device.wecomAllowed===true,appSlots:(device.appSlots||[]).map(s=>s.appSlot).filter(s=>['main','clone'].includes(s)),
    available:device.available===true,unavailableReason:code(device.unavailableReason),adbLastSeenAt:safe(device.adbLastSeenAt)};
}
const projectJob=job=>({taskId:safe(job.jobId),deviceNumber:safe(job.deviceNumber),appSlot:safe(job.appSlot),mode:safe(job.mode),status:safe(job.status),
  createdAt:safe(job.createdAt),completedAt:safe(job.completedAt),code:code(job.result?.code),
  invitationSent:job.result?.invitationSent,sendStatus:safe(job.result?.sendStatus),sendClaimed:job.result?.sendClaimed===true,
  remarkSaveStatus:safe(job.result?.remarkSaveStatus)});

async function main(){
  const requests=[];
  async function request(method,route,token='',body){
    if(!allowedRequest(method,route,body))throw Error('request_outside_readonly_scope');
    const began=performance.now();
    const response=await fetch(origin+route,{method,redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    let raw='',bytes=0;
    for await(const part of response.body){bytes+=part.byteLength;if(bytes>2*1024*1024)throw Error('response_bound_exceeded');raw+=Buffer.from(part).toString('utf8');}
    const value=JSON.parse(raw);
    requests.push({method,route,httpStatus:response.status,elapsedMs:Math.round(performance.now()-began),sha256:createHash('sha256').update(raw).digest('hex'),
      ...(value.error?{error:code(value.error)}:{})});
    return {status:response.status,value};
  }
  if(!process.env.ADMIN_USERNAME||!process.env.ADMIN_PASSWORD)throw Error('approved_auth_environment_unavailable');
  const login=await request('POST','/api/v1/auth/login','',{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD});
  const token=login.value.session?.token;if(login.status!==200||!token)throw Error('admin_auth_unavailable');
  // Login body/response, API token and any customer/account fields stay in RAM.
  const full=await request('GET','/api/v1/wecom/devices',token);
  const online=await request('GET','/api/v1/wecom/devices?onlineOnly=true',token);
  const badFilter=await request('GET','/api/v1/wecom/devices?onlineOnly=invalid',token);
  const pool=await request('GET','/api/v1/admin/lookup-pool',token);
  const catalog=await request('GET','/api/v1/user/automation/wecom-preview-devices',token);
  const history=await request('GET','/api/v1/user/automation/wecom-preview-tasks',token);
  if([full,online,pool,catalog,history].some(r=>r.status!==200))throw Error('readonly_catalog_unavailable');
  const devices=full.value.devices.map(projectDevice);
  const rows=numbers.map(number=>{
    const matches=devices.filter(d=>d.number===number);
    const lookup=pool.value.pool?.devices?.filter(d=>String(d.deviceNumber)===number)||[];
    const mapped=catalog.value.devices?.filter(d=>String(d.deviceNumber)===number)||[];
    return {number,mappingCount:matches.length,...(matches.length===1?matches[0]:{}),
      internalCatalogMappingCount:mapped.length,inEnabledLookupPool:lookup.some(d=>d.enabled===true),
      nativeAttemptedThisRound:false,sendAttemptedThisRound:false};
  });
  const modelMap=new Map();
  for(const d of devices){const key=JSON.stringify([d.brand,d.model,d.androidVersion]);let g=modelMap.get(key);
    if(!g){g={brand:d.brand,model:d.model,androidVersion:d.androidVersion,total:0,online:0,wecomConfigured:0};modelMap.set(key,g);}
    g.total++;g.online+=Number(d.online);g.wecomConfigured+=Number(d.wecomAllowed);
  }
  const jobs=(history.value.tasks||[]).filter(j=>numbers.includes(String(j.deviceNumber))).map(projectJob);
  const selected=new Map();
  for(const j of jobs.filter(j=>j.mode==='send').sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))){
    const key=j.deviceNumber+'/'+j.appSlot;if(!selected.has(key))selected.set(key,j);
  }
  const results=[];
  for(const job of selected.values()){
    if(!/^[a-f0-9-]{36}$/.test(job.taskId))continue;
    const r=await request('GET','/api/v1/wecom/customer-invitations/'+job.taskId,token);
    results.push({taskId:job.taskId,deviceNumber:job.deviceNumber,appSlot:job.appSlot,httpStatus:r.status,
      status:safe(r.value.status),code:code(r.value.code),matchesOriginalId:r.value.taskId===job.taskId,
      historicalOnly:true});
  }
  await request('GET','/api/v1/wecom/customer-invitations/00000000-0000-4000-8000-000000000000',token);
  const original='7b993763-6364-40fb-9599-2af3bb8d9da3';
  const originalPreview=await request('GET','/api/v1/user/automation/wecom-preview-tasks/'+original,token);
  const noSendAlias=await request('GET','/api/v1/wecom/customer-invitations/'+original,token);
  console.log(JSON.stringify({atUtc:new Date().toISOString(),origin,scope:'external GET inventory/results only; auth login is the sole POST',
    inventoryUpdatedAt:safe(full.value.updatedAt),total:full.value.total,onlineTotal:online.value.total,capacity:full.value.capacity,
    invalidFilterRejected:badFilter.status===400,onlineFilterAllRowsOnline:online.value.devices.every(d=>d.online===true),
    lookupCounts:pool.value.pool?.counts,configuredPhones:rows,allPlatformModelGroups:[...modelMap.values()],
    boundedHistoryJobs:jobs,historyPageLimit:100,historicalExternalResults:results,
    original43Preview:originalPreview.status===200?projectJob(originalPreview.value.task):{httpStatus:originalPreview.status},
    originalPreviewRejectedByExternalSendResult:noSendAlias.status===404,
    requests,phoneJobsCreated:0,phoneActions:0,invitationSendCalls:0,
    limitations:['Cached platform metadata, not fresh device OS reads.','Platform available does not override native freeze, independent obligations or lookup-pool exclusion.',
      'Historical results do not prove current-version native acceptance.','No external POST preview capability exists in source32c; no native jobs were submitted.','History is bounded to the latest 100 WeCom jobs of the authenticated account.']}));
}
if(process.argv.includes('--collect'))main().catch(error=>{
  console.log(JSON.stringify({failed:true,code:/^[a-z0-9_]+$/.test(error.message||'')?error.message:'readonly_transport_or_response_failed',phoneActions:0}));process.exitCode=1;
});
