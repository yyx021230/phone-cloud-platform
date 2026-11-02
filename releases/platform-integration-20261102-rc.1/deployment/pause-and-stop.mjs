import crypto from 'node:crypto';
const base='http://127.0.0.1:'+process.env.PORT,auth=process.env.ADMIN_API_TOKEN;
if(!auth)throw Error('admin_auth_unavailable');
const terminal=new Set(['succeeded','not_found','failed','cancelled','expired']);
async function api(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+auth,...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)throw Error('deployment_api_'+r.status+'_'+String(d.code||d.error||'unknown'));return d;}
const pool=(await api('/api/v1/admin/lookup-pool')).pool;
const tasks=(await api('/api/v1/windows-agent-tasks?limit=200')).tasks||[];
const other=tasks.filter(t=>!terminal.has(t.status)&&!t.type?.startsWith('alipay_name_'));
if(other.length)throw Error('new_non_lookup_active_tasks_require_review');
const clients=new Map(JSON.parse(process.env.OPEN_NAME_LOOKUP_CLIENTS_JSON||'[]').map(c=>[c.clientId,c]));
for(const prep of pool.preparations||[])if(!clients.get(prep.clientId)?.secret)throw Error('round_client_not_configured');
const before={enabled:pool.config.enabled,configRevision:pool.configRevision,preparations:(pool.preparations||[]).map(p=>({clientId:p.clientId,preparationId:p.preparationId})),requests:(pool.requests||[]).filter(r=>!terminal.has(r.status)).map(r=>({lookupId:r.lookupId,purpose:r.purpose||'business',status:r.status})),tasks:tasks.filter(t=>!terminal.has(t.status)).map(t=>({taskId:t.taskId,type:t.type,status:t.status}))};
await api('/api/v1/admin/lookup-pool','PUT',{expectedConfigRevision:pool.configRevision,enabled:false});
const stops=[];
for(const p of pool.preparations||[]){
 const c=clients.get(p.clientId),path='/api/v1/open/name-lookups/stop',body={preparationId:p.preparationId},raw=JSON.stringify(body),timestamp=String(Date.now()),nonce=crypto.randomUUID();
 const sig=crypto.createHmac('sha256',c.secret).update(['POST',path,timestamp,nonce,crypto.createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
 const r=await api(path,'POST',body,{'x-client-id':p.clientId,'x-timestamp':timestamp,'x-nonce':nonce,'x-signature':sig,'idempotency-key':'deployment-20261102-stop-'+p.preparationId});
 stops.push({preparationId:p.preparationId,stopped:r.stopped,status:r.status});
}
const after=(await api('/api/v1/admin/lookup-pool')).pool;
if(after.config.enabled!==false)throw Error('pool_gate_not_closed');
const unfinished=(after.requests||[]).filter(r=>!terminal.has(r.status));
if(unfinished.some(r=>!r.cancelRequested))throw Error('live_request_without_cancel_intent');
console.log(JSON.stringify({at:new Date().toISOString(),before,stops,after:{enabled:after.config.enabled,configRevision:after.configRevision,requests:unfinished.map(r=>({lookupId:r.lookupId,status:r.status,cancelRequested:r.cancelRequested,cancelReason:r.cancelReason})),channels:(after.channels||[]).map(c=>({deviceId:c.deviceId,sessionId:c.sessionId,generation:c.generation,phase:c.phase}))},physicalCleanupNotAssumed:true}));
