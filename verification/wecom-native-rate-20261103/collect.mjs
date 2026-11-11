// One bounded read-only occupancy observation; no task, lease, expiry or phone calls.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
const expected={"server/index.mjs": "4bcecc8702ea577a77e5f17664b7833ced33b681f88e5beedcdc6875b6f047cc", "server/wecom-preview.mjs": "ec9126e6c85d787f80355df8b5c84fb5c525f8ba746847573c9d5b589779cbaf", "server/screen-sessions.mjs": "811a15aa7ecb87a934ef5f92826ed9031278d87df2387cc20a85098ce91cde09", "server/managed-lookup.mjs": "74fc9138a8ffc571b4504964762432386d6995426131e4a8b861032161dc7f44", "server/managed-lookup-platform.mjs": "c641ee8e32a30262fe93ae96a6317c24a89b9813c7e1ff16ad19cbe52b96a2f2", "server/postgres-repositories.mjs": "22f7e458bf28e8252639c5bcc5957d56abe8361307baa79432bb869fa34c65ad", "server/wecom-physical-cleanup.mjs": "7fea00c14fcd6df20a30b5492c4c52c244b6dec26bbc5169212d0fcd2e15a07b", "server/wecom-cleanup-service.mjs": "fb594dd7a191bb37f7a2abdf508298059ca4730814f394c491965f0c46c366a0"};
Object.assign(expected,{"server/device-occupancy.mjs": "4f33caecf089118a2b7e4241f21a763dd83f1b37f42c9d378a6a748a6e49d81a", "server/recovery-controls.mjs": "0147f3f3c122e9d444bf48666cb6bbaab64a64c585860ca0664afdec44890af8"});
const numbers=['43','157','93','59','145','25','23','155'];
let queryNumber=0;let queryTable=null;let stage='source_hash',firstError=null,client=null,transaction=false;
const deadline=Date.now()+20000;
const out={version:1,purpose:'readonly_candidate_occupancy_not_admission',startedAt:new Date().toISOString(),sourceCommit:'32c0091a534aa7f9038deb91aa33f202f72e0e6b',sourceHashes:{},apiRoutes:[],nonAtomicAcrossApiAndDb:true,notLeaseOrNativeWorkerProof:true};
const fail=code=>{throw Object.assign(Error(),{fixedCode:code});};
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
async function get(route){
 if(!['/api/v1/wecom/devices','/api/v1/windows-agents'].includes(route))fail('route_not_whitelisted');
 const response=await fetch('http://127.0.0.1:'+(process.env.PORT||8787)+route,{method:'GET',headers:{authorization:'Bearer '+process.env.ADMIN_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(4000)});
 if(response.status!==200)fail('http_not_200');let count=0,parts=[];
 for await(const chunk of response.body){count+=chunk.length;if(count>4194304)fail('http_body_budget');parts.push(chunk);}
 const body=JSON.parse(Buffer.concat(parts).toString('utf8'));out.apiRoutes.push({route,status:response.status,bytes:count});return body;
}
const query=async(sql,values=[])=>{queryNumber++;queryTable=sql.match(/FROM (phone_cloud_[a-z_]+)/i)?.[1]||'transaction_control';if(Date.now()>=deadline)fail('whole_operation_budget');if(firstError)fail('pg_connection_error');const r=await client.query({text:sql,values,query_timeout:4000});if(firstError)fail('pg_connection_error');return r;};
const onError=()=>{firstError=true;};
function numericMetrics(value,prefix='',depth=0,result={}){
 if(depth>5||!value||typeof value!=='object')return result;
 for(const [key,x]of Object.entries(value)){
  if(!/^[A-Za-z0-9_]{1,80}$/.test(key)||/token|password|secret|credential/i.test(key))continue;
  const path=prefix?prefix+'.'+key:key;
  if(typeof x==='number'&&Number.isFinite(x)&&/reader|worker|capacity|running|active|limit|max|receivedAt/i.test(path))result[path]=x;
  else if(Array.isArray(x)&&/activeTaskIds|worker|reader/i.test(path))result[path+'.length']=x.length;
  else if(x&&typeof x==='object'&&!Array.isArray(x)&&(/reader|worker|capacity|health|lookup|runtime|resource/i.test(path)))numericMetrics(x,path,depth+1,result);
 }
 return result;
}
try{
 for(const [name,hash]of Object.entries(expected)){const actual=createHash('sha256').update(fs.readFileSync(name)).digest('hex');if(actual!==hash)fail('production_source_mismatch');out.sourceHashes[name]=actual;}
 if(!process.env.ADMIN_API_TOKEN||!process.env.DATABASE_URL)fail('required_environment_absent');
 stage='readonly_api';const [inventory,agents]=await Promise.all([get('/api/v1/wecom/devices'),get('/api/v1/windows-agents')]);
 if(!Array.isArray(inventory.devices)||!Array.isArray(agents.agents))fail('api_schema');
 const selected=inventory.devices.filter(d=>numbers.includes(String(d.deviceNumber)));
 for(const n of numbers)if(selected.filter(d=>String(d.deviceNumber)===n).length!==1)fail('api_number_mapping_incomplete');
 out.api={fleet:inventory.devices.map(d=>pick(d,['deviceNumber','online','adbOnline','agentOnline','listed','available','busy','unavailableReason'])),at:inventory.updatedAt,deviceCount:inventory.devices.length,declaredTotal:inventory.total,capacity:inventory.capacity,candidates:selected.map(d=>({...pick(d,['deviceNumber','online','adbOnline','agentOnline','listed','available','busy','wecomAllowed','appSlots','unavailableReason','lastSeenAt','adbLastSeenAt']),occupancy:pick(d.occupancy,['type','label'])})),agents:agents.agents.map(a=>({...pick(a,['agentId','enabled','revokedAt','lastSeenAt','lookupRuntimeId']),reportedDeviceCount:Array.isArray(a.devices)?a.devices.length:null,taskCounts:a.taskCounts,metrics:numericMetrics(a),metadataKeys:Object.keys(a).filter(k=>/reader|worker|capacity|runtime|recovery|lookup/i.test(k))}))};
 stage='readonly_pg';client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'native-preview-occupancy-readonly-20261103',connectionTimeoutMillis:4000,query_timeout:4000});client.on('error',onError);await client.connect();
 await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
 await query("SET LOCAL statement_timeout='3000ms'");await query("SET LOCAL lock_timeout='1000ms'");await query("SET LOCAL idle_in_transaction_session_timeout='5000ms'");
 const proof=(await query("SELECT current_setting('transaction_read_only') AS read_only,transaction_timestamp() AS snapshot_at,pg_backend_pid() AS backend_pid")).rows[0];if(proof.read_only!=='on')fail('transaction_not_readonly');out.pg={proof};
 out.pg.devices=(await query("SELECT device_id,data->>'deviceName' AS device_number,data#>>'{adb,state}' AS adb_state,data#>>'{adb,lastSeenAt}' AS adb_last_seen,data#>>'{adb,agentId}' AS agent_id,updated_at FROM phone_cloud_devices WHERE data->>'deviceName'=ANY($1::text[])",[numbers])).rows;
 for(const n of numbers)if(out.pg.devices.filter(d=>d.device_number===n).length!==1)fail('db_number_mapping_incomplete');
 const ids=out.pg.devices.map(d=>d.device_id);
 out.pg.fleetDevices=(await query("SELECT device_id,data->>'deviceName' AS device_number,data#>>'{adb,state}' AS adb_state,data#>>'{adb,agentId}' AS agent_id,updated_at FROM phone_cloud_devices ORDER BY device_id LIMIT 2001")).rows;if(out.pg.fleetDevices.length>2000)fail('fleet_device_budget');
 const lc=(await query("SELECT count(*)::int AS n FROM phone_cloud_device_locks WHERE coalesce(status,'')<>'released'")).rows[0].n;if(lc>2000)fail('nonreleased_lock_budget');
 out.pg.nonreleasedLocks=(await query("SELECT lock_id,device_id,status,expires_at,data->>'lockType' AS lock_type,data->>'taskId' AS task_id,data->>'appSlot' AS app_slot,data#>>'{physicalCleanup,phase}' AS physical_phase,data#>>'{physicalCleanup,binding,originalTaskId}' AS original_task_id FROM phone_cloud_device_locks WHERE coalesce(status,'')<>'released' ORDER BY device_id,lock_id")).rows;
 const terminal=['succeeded','failed','cancelled','expired'];
 // All agents' nonterminal tasks: do not lose rows with missing/stale JSON deviceId or serial.
 const tc=(await query("SELECT count(*)::int AS n FROM phone_cloud_windows_tasks WHERE NOT(coalesce(status,'')=ANY($1::text[]))",[terminal])).rows[0].n;if(tc>2000)fail('active_task_budget');
 out.pg.nonterminalTasks=(await query("SELECT task_id,data->>'deviceId' AS device_id,agent_id,status,updated_at,data->>'type' AS task_type,data#>>'{payload,appSlot}' AS app_slot,data#>>'{payload,physicalCleanup,obligationId}' AS obligation_id,CASE WHEN adb_serial IS NULL OR adb_serial='' THEN false ELSE EXISTS(SELECT 1 FROM phone_cloud_devices d WHERE d.device_id=ANY($2::text[]) AND d.data#>>'{adb,serial}'=adb_serial) END AS candidate_serial_match FROM phone_cloud_windows_tasks WHERE NOT(coalesce(status,'')=ANY($1::text[])) ORDER BY task_id",[terminal,ids])).rows;
 const jc=(await query("SELECT count(*)::int AS n FROM phone_cloud_automation_jobs WHERE NOT(coalesce(status,'')=ANY($1::text[]))",[terminal])).rows[0].n;if(jc>2000)fail('active_job_budget');
 out.pg.nonterminalJobs=(await query("SELECT job_id,device_id,kind,status,updated_at,data->>'windowsTaskId' AS windows_task_id,data->>'sessionId' AS session_id FROM phone_cloud_automation_jobs WHERE NOT(coalesce(status,'')=ANY($1::text[])) ORDER BY device_id,job_id",[terminal])).rows;
 const sessions=(await query("SELECT session_id,device_id,data->>'deviceId' AS json_device_id,status,data->>'pendingJobId' AS pending_job_id,data->>'lockId' AS lock_id,(data ? 'lookupStopFailure' AND data->'lookupStopFailure' IS DISTINCT FROM 'null'::jsonb) AS stop_failure_present FROM phone_cloud_automation_sessions WHERE (NOT(coalesce(status,'')=ANY($1::text[])) OR (data ? 'lookupStopFailure' AND data->'lookupStopFailure' IS DISTINCT FROM 'null'::jsonb)) LIMIT 2001",[['ended','failed','expired','cancelled']])).rows;if(sessions.length>2000)fail('session_budget');out.pg.nonterminalOrStopFailureSessions=sessions;
 const pools=(await query("SELECT state_key,updated_at,data->>'revision' AS revision,data#>>'{config,enabled}' AS config_enabled,data->'devices' AS devices,data->'channels' AS channels,data->'preparations' AS preparations,data->'roundStops' AS round_stops,ARRAY(SELECT jsonb_object_keys(data)) AS top_level_keys FROM phone_cloud_managed_lookup ORDER BY state_key")).rows;
 if(pools.length!==1||pools.some(p=>!Array.isArray(p.devices)||!Array.isArray(p.channels)))fail('pool_scope_incomplete');
 out.pg.pools=pools.map(pool=>({...pick(pool,['state_key','updated_at','revision','config_enabled','top_level_keys']),deviceCount:pool.devices?.length,channelCount:pool.channels?.length,devices:(pool.devices||[]).map(d=>({...pick(d,['deviceId','deviceNumber','enabled','prepareFailureCount','quarantineUntil']),accountOffline:Boolean(d.accountOffline),issue:pick(d.preparationIssue,['domain','code','at','retryAt']),stateFieldNames:Object.keys(d).filter(k=>/stop|barrier|cleanup|recover/i.test(k))})),channels:(pool.channels||[]).map(c=>({...pick(c,['deviceId','generation','phase','sessionId','requestId','queryId','roundStopPreparationId','roundStopReason','offlineHandoffSince','offlineHandoffAt','offlineHandoffRequestId','roundStopDetachedAt','roundStopOfflineSince']),stateFieldNames:Object.keys(c).filter(k=>/stop|barrier|cleanup|recover/i.test(k))})),preparations:Array.isArray(pool.preparations)?pool.preparations.map(p=>pick(p,['preparationId','status','createdAt','updatedAt','stopRequestedAt','stoppedAt'])):null,roundStops:Array.isArray(pool.round_stops)?pool.round_stops.map(p=>pick(p,['preparationId','status','createdAt','updatedAt','stoppedAt'])):null}));
 const end=await query('ROLLBACK');transaction=false;if(end.command!=='ROLLBACK')fail('readonly_transaction_end_unknown');
 await client.end();client.removeListener('error',onError);client=null;
 out.status='observed_not_admitted';out.finishedAt=new Date().toISOString();out.sqlRowsCountChecked=true;out.fullOccupancyAdmissionProven=false;out.unverifiedSources=['windows_native_workers','lookup_outbox','original_stop_proofs','cross_api_db_atomicity'];out.taskScope='all_agents_all_nonterminal_tasks';out.databaseScope='all_fleet_nonreleased_locks_nonterminal_jobs_and_unclosed_sessions';out.candidateMapping='one_row_per_number_in_api_and_db' ;out.windowsNativeIdentityAndWorkerFactsFresh=false;
 console.log(JSON.stringify(out));
}catch(error){
 if(client){if(transaction&&!firstError)await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});client.removeListener('error',onError);}
 out.status='unknown';out.failure={stage,queryNumber,queryTable,code:error.fixedCode||(/^[0-9A-Z]{5}$/.test(error.code||'')?error.code:'readonly_observation_failed'),noLeaseOrTaskOrPhoneAction:true};out.finishedAt=new Date().toISOString();out.partialObservationOnly=true;out.fullOccupancyAdmissionProven=false;console.log(JSON.stringify(out));process.exitCode=1;
}
