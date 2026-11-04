// One target, read-only SQL snapshot plus independently observed runtime views.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import net from 'node:net';
try{
let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>4096)throw Error('qa_input_budget');}
const input=JSON.parse(raw), t=input.target;
if(!t||!/^adb:[A-Za-z0-9_.:-]+$/.test(t.deviceId)||t.deviceId!=='adb:'+t.serial||!/^\d{1,3}$/.test(t.deviceNumber))throw Error('qa_target_invalid');
const hash=()=>createHash('sha256').update(fs.readFileSync('server/index.mjs')).digest('hex');
const expected='e65c591b962056b5a03460c9b41fc127add40b5e42ba88355f9f6c6db3303754';
if(hash()!==expected)throw Error('qa_production_source_changed');
// Reuse only the exact hash-pinned production RESP client definitions. Do not
// import/start server/index or call its memory fallback/lock-expiry endpoints.
const runtimeSource=fs.readFileSync('server/index.mjs','utf8');
const start=runtimeSource.indexOf('function createRedisRuntimeClient('),end=runtimeSource.indexOf('function runtimeJsonSet(',start);
if(start<0||end<start||!process.env.REDIS_URL)throw Error('qa_runtime_lock_backend_unknown');
const makeRedis=new Function('net','Buffer','URL','REDIS_COMMAND_TIMEOUT_MS',runtimeSource.slice(start,end)+';return createRedisRuntimeClient;')(net,Buffer,URL,1500);
const redis=makeRedis(process.env.REDIS_URL),key='lock:device:'+t.deviceId;
const rawLock=await redis.command(['GET',key]);
const lockTtl=await redis.command(['PTTL',key]);
if(await redis.command(['GET',key])!==rawLock)throw Error('qa_runtime_lock_changed');
if(rawLock===null&&lockTtl!==-2)throw Error('qa_runtime_lock_unknown');
if(rawLock!==null&&(typeof rawLock!=='string'||rawLock.length>16384||!Number.isFinite(lockTtl)||lockTtl<=0))throw Error('qa_runtime_lock_unknown');
const runtimeLock=rawLock===null?null:JSON.parse(rawLock);
const deadline=Date.now()+5000, client=new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000,query_timeout:1500});
const run=async(s,v=[])=>{if(Date.now()>=deadline)throw Error('qa_read_deadline');const r=await client.query(s,v);if(r.rows.length>2000)throw Error('qa_row_budget');return r.rows;};
const terminal=['succeeded','failed','cancelled','expired'];
let result;
try{
 await client.connect();await run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await run("SET LOCAL statement_timeout='1500ms'");await run("SET LOCAL lock_timeout='500ms'");await run("SET LOCAL idle_in_transaction_session_timeout='4000ms'");
 const proof=(await run("SELECT current_setting('transaction_read_only') AS mode,transaction_timestamp() AS at"))[0];if(proof.mode!=='on')throw Error('qa_not_readonly');
 const ds=await run("SELECT device_id,data FROM phone_cloud_devices WHERE lower(device_id)=lower($1) OR lower(data#>>'{adb,serial}')=lower($2) OR data->>'deviceName'=$3 LIMIT 2001",[t.deviceId,t.serial,t.deviceNumber]);
 if(ds.length!==1||ds[0].device_id!==t.deviceId||ds[0].data.adb?.serial!==t.serial||ds[0].data.deviceName!==t.deviceNumber)throw Error('qa_device_alias_conflict');
 const d=ds[0].data;
 const locks=await run("SELECT lock_id,device_id,status,expires_at,data->>'lockType' AS type,data->>'taskId' AS task_id,data->>'ownerUserId' AS owner FROM phone_cloud_device_locks WHERE coalesce(status,'')<>'released' AND (lower(device_id)=lower($1) OR lower(data->>'deviceId')=lower($1) OR lower(data#>>'{physicalCleanup,binding,serial}')=lower($2) OR lower(data#>>'{physicalCleanup,legacySerial}')=lower($2)) LIMIT 2001",[t.deviceId,t.serial]);
 const tasks=await run("SELECT task_id,status,agent_id,data->>'deviceId' AS device_id,adb_serial,data->>'type' AS type FROM phone_cloud_windows_tasks WHERE NOT(coalesce(status,'')=ANY($3::text[])) AND (lower(data->>'deviceId')=lower($1) OR lower(adb_serial)=lower($2) OR (coalesce(data->>'deviceId','')='' AND coalesce(adb_serial,'')='')) LIMIT 2001",[t.deviceId,t.serial,terminal]);
 const jobs=await run("SELECT job_id,device_id,kind,status FROM phone_cloud_automation_jobs WHERE NOT(coalesce(status,'')=ANY($2::text[])) AND (lower(device_id)=lower($1) OR coalesce(device_id,'')='') LIMIT 2001",[t.deviceId,terminal]);
 const sessions=await run("SELECT session_id,device_id,status,data->>'pendingJobId' AS pending_job_id FROM phone_cloud_automation_sessions WHERE (NOT(coalesce(status,'')=ANY($2::text[])) OR (data ? 'lookupStopFailure' AND data->'lookupStopFailure' IS DISTINCT FROM 'null'::jsonb)) AND (lower(device_id)=lower($1) OR coalesce(device_id,'')='') LIMIT 2001",[t.deviceId,['ended','failed','expired','cancelled']]);
 const pools=await run('SELECT data FROM phone_cloud_managed_lookup LIMIT 2');if(pools.length!==1||!Array.isArray(pools[0].data.devices)||!Array.isArray(pools[0].data.channels))throw Error('qa_pool_unknown');
 const pool=pools[0].data;if(!Array.isArray(pool.preparations)||!Array.isArray(pool.roundStops))throw Error('qa_pool_stops_unknown');
 const mentions=(v,depth=0)=>depth>12?true:typeof v==='string'?[t.deviceId,t.serial,t.deviceNumber].map(x=>x.toLowerCase()).includes(v.toLowerCase()):Array.isArray(v)?v.some(x=>mentions(x,depth+1)):v&&typeof v==='object'?Object.values(v).some(x=>mentions(x,depth+1)):false;
 // No broad status-based exemption: a failed/stopped record can still owe
 // original cleanup. This bounded QA reader blocks any target mention unless
 // a later reviewed physical-stop proof projection establishes closure.
 const stops=[...pool.preparations,...pool.roundStops].filter(x=>mentions(x));
 result={at:proof.at,nonAtomicAcrossRuntime:true,devices:[{deviceId:d.deviceId,deviceName:d.deviceName,listingStatus:d.listingStatus,unlistedAt:d.unlistedAt,updatedAt:d.updatedAt,adb:{serial:d.adb.serial,agentId:d.adb.agentId,state:d.adb.state,lastSeenAt:d.adb.lastSeenAt}}],locks,tasks,jobs,sessions,lookupExcluded:!pool.devices.some(x=>x.enabled&&String(x.deviceId).toLowerCase()===t.deviceId.toLowerCase())&&!pool.channels.some(x=>String(x.deviceId).toLowerCase()===t.deviceId.toLowerCase())&&!stops.length};
 await run('ROLLBACK');
}finally{await client.end();}
async function get(route){const r=await fetch('http://127.0.0.1:8787'+route,{headers:{authorization:'Bearer '+process.env.ADMIN_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(1800)});if(r.status!==200)throw Error('qa_runtime_read_failed');return r.json();}
const inventory=await get('/api/v1/wecom/devices'),rows=inventory.devices.filter(d=>d.deviceNumber===t.deviceNumber);if(rows.length!==1)throw Error('qa_runtime_alias_conflict');
result.runtime=Object.fromEntries(['online','adbOnline','agentOnline','listed','busy','available','occupancy','unavailableReason'].map(k=>[k,rows[0][k]]));
result.pgLocks=result.locks;result.runtimeLockTtlMs=lockTtl;
if(runtimeLock){
 const l=runtimeLock;
 if(l.deviceId!==t.deviceId||typeof l.lockId!=='string'||!l.lockId||typeof l.taskId!=='string'||typeof l.ownerUserId!=='string'||l.status!=='active'||!Number.isFinite(Date.parse(l.expiresAt)))throw Error('qa_runtime_lock_invalid');
 const row={lock_id:l.lockId,device_id:l.deviceId,status:l.status,expires_at:l.expiresAt,type:l.lockType,task_id:l.taskId,owner:l.ownerUserId};
 const same=result.locks.find(x=>x.lock_id===row.lock_id);
 if(same&&['device_id','status','type','task_id','owner'].some(k=>same[k]!==row[k]))throw Error('qa_runtime_lock_conflict');
 if(!same)result.locks=[...result.locks,row];
}
if(input.session){if(!/^[a-f0-9-]{36}$/.test(input.session))throw Error('qa_session_invalid');const s=(await get('/api/v1/screen-sessions/'+input.session)).session;result.session=Object.fromEntries(['sessionId','deviceId','status','expiresAt','userId','agentId','adbSerial'].map(k=>[k,s[k]]));}
if(hash()!==expected)throw Error('qa_production_source_changed');
if(result.session)result.expiresInSeconds=Math.min(lockTtl/1000,(Math.min(Date.parse(result.session.expiresAt),...result.locks.map(l=>Date.parse(l.expires_at)))-Date.now())/1000);
console.log(JSON.stringify(result));
}catch{console.log(JSON.stringify({error:'qa_single_read_unknown'}));process.exitCode=1;}
