import {lookupRequestPage} from './lookup-admin-console.mjs';
import {ASYNC_LOOKUP_DEFAULTS} from './managed-lookup-async.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// ECMAScript trim whitespace, also used for archive eligibility in PostgreSQL.
const NAME_WHITESPACE=' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

export const LOOKUP_POOL_NUMBERS = Object.freeze([51,52,54,55,87,138,152,188,172,156,155,115,60,58,164,163,154,6,57,10,183,82,86,121,146,149,153,181,182,162,161,142,74,78,79,118,130,157,147,101,107,165,112,67,53,128,158,143,148]);
export const MANAGED_LOOKUP_PROTOCOL = 'managed_lookup_v1';
export function initialManagedLookupState() {
  return {version:1, revision:0, config:{...ASYNC_LOOKUP_DEFAULTS,enabled:false, concurrency:5, waitMs:120000, idleMs:120000, queueLimit:1000, clientQueueLimit:200, waiterLimit:20, humanLimit:5, humanWaitMs:1800000}, devices:[], grants:[], requests:[], channels:[], audits:[], lastClient:''};
}

// A single service process owns the existing in-memory platform state. The
// advisory/file owner lock deliberately rejects a second managed coordinator.
// PostgreSQL transaction includes both this state and legacy task mutations.
export async function createManagedLookupStore({getPool, file, key='default', persistLegacy}={}) {
  let value, tail=Promise.resolve(), owner, fenced=false;
  const lockFile=file && file+'.owner';
  if(getPool) {
    owner=await (await getPool()).connect();
    owner.on('error',()=>{fenced=true;});
    const acquired=await owner.query("select pg_try_advisory_lock(hashtext('phone_cloud_managed_lookup'),hashtext($1)) as locked",[key]);
    if(!acquired.rows[0].locked){owner.release();throw new Error('managed_lookup_coordinator_already_active');}
    try {
      const row=await owner.query('select data from phone_cloud_managed_lookup where state_key=$1',[key]);
      if(!row.rows.length) await owner.query('insert into phone_cloud_managed_lookup(state_key,data) values($1,$2::jsonb)',[key,JSON.stringify(initialManagedLookupState())]);
      value=row.rows[0]?.data || initialManagedLookupState();
    }catch(e){await owner.query("select pg_advisory_unlock(hashtext('phone_cloud_managed_lookup'),hashtext($1))",[key]).catch(()=>{});owner.release();throw e;}
  }else{
    await fs.mkdir(path.dirname(file),{recursive:true});
    try {const old=JSON.parse(await fs.readFile(lockFile,'utf8'));try{process.kill(old.pid,0);throw new Error('managed_lookup_coordinator_already_active');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(lockFile);}catch(e){if(e.code!=='ENOENT')throw e;}
    const fd=await fs.open(lockFile,'wx',0o600);await fd.writeFile(JSON.stringify({pid:process.pid}));await fd.close();
    try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;value=initialManagedLookupState();}
  }
  if(value.version!==1) throw new Error('managed_lookup_schema_version_unsupported');
  const saveFile=async next=>{const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(next),{mode:0o600});const fd=await fs.open(tmp,'r');try{await fd.sync();}finally{await fd.close();}await fs.rename(tmp,file);};
  return {
    snapshot:()=>structuredClone(value),
    async readRequest(id,clientId){
      const r=value.requests.find(r=>r.lookupId===id&&r.clientId===clientId);if(r)return structuredClone(r);
      if(!getPool)return null;const row=await (await getPool()).query('select data from phone_cloud_managed_lookup_results where state_key=$1 and lookup_id=$2 and client_id=$3',[key,id,clientId]);return row.rows[0]?.data||null;
    },
    async adminRequest(id){
      const live=value.requests.find(r=>r.lookupId===id);if(live)return structuredClone(live);
      if(!getPool)return null;
      return (await (await getPool()).query('select data from phone_cloud_managed_lookup_results where state_key=$1 and lookup_id=$2',[key,id])).rows[0]?.data||null;
    },
    async adminRequests(cursor){
      let archived=[];
      if(getPool)archived=(await (await getPool()).query("select data from phone_cloud_managed_lookup_results where state_key=$1 and coalesce(data->>'purpose','')<>'readiness_probe' and ($2::text is null or (data->>'createdAt',lookup_id)<($2,$3)) order by data->>'createdAt' desc,lookup_id desc limit 31",[key,cursor?.createdAt||null,cursor?.lookupId||null])).rows.map(r=>r.data);
      return lookupRequestPage([...archived,...value.requests],cursor);
    },
    isFenced:()=>fenced,
    async transact(operation){
      const job=tail.then(async()=>{
        if(fenced)throw new Error('managed_lookup_storage_fenced');
        let client;const rollbacks=[],commits=[];
        try{
          if(getPool){client=await (await getPool()).connect();await client.query('begin');const rows=await client.query('select data from phone_cloud_managed_lookup where state_key=$1 for update',[key]);if(!rows.rows.length)throw new Error('managed_lookup_state_missing');value=rows.rows[0].data;}
          const next=structuredClone(value);
          const result=await operation(next,{client,onRollback:fn=>rollbacks.push(fn),onCommit:fn=>commits.push(fn), archived:async(clientId,requestKey)=>client?(await client.query('select data from phone_cloud_managed_lookup_results where state_key=$1 and client_id=$2 and idempotency_key=$3',[key,clientId,requestKey])).rows[0]?.data:null, alias:async(clientId,requestKey)=>client?(await client.query('select client_id as "clientId",idempotency_key as "idempotencyKey",lookup_id as "lookupId",fingerprint from phone_cloud_managed_lookup_aliases where state_key=$1 and client_id=$2 and idempotency_key=$3',[key,clientId,requestKey])).rows[0]:(next.aliases||[]).find(a=>a.clientId===clientId&&a.idempotencyKey===requestKey),
          request:async(clientId,id)=>client?(await client.query('select data from phone_cloud_managed_lookup_results where state_key=$1 and client_id=$2 and lookup_id=$3',[key,clientId,id])).rows[0]?.data:next.requests.find(r=>r.clientId===clientId&&r.lookupId===id),
          aliasCount:async(clientId,id)=>client?Number((await client.query('select count(*) as count from phone_cloud_managed_lookup_aliases where state_key=$1 and client_id=$2 and lookup_id=$3',[key,clientId,id])).rows[0].count):(next.aliases||[]).filter(a=>a.clientId===clientId&&a.lookupId===id).length,
          addAlias:async a=>{if(client)await client.query('insert into phone_cloud_managed_lookup_aliases(state_key,client_id,idempotency_key,lookup_id,fingerprint,created_at) values($1,$2,$3,$4,$5,$6)',[key,a.clientId,a.idempotencyKey,a.lookupId,a.fingerprint,a.createdAt]);else(next.aliases||=[]).push(a);},
          namedHistory:async(clientId,fingerprint,before)=>client?(await client.query("select data from phone_cloud_managed_lookup_results where state_key=$1 and client_id=$2 and data->>'fingerprint'=$3 and coalesce(data->>'purpose','')<>'readiness_probe' and data->>'status'='succeeded' and jsonb_typeof(data->'name')='string' and btrim(data->>'name',$5)<>'' and completed_at<=$4::timestamptz order by completed_at desc,lookup_id limit 1",[key,clientId,fingerprint,before,NAME_WHITESPACE])).rows[0]?.data:null});
          next.revision=(value.revision||0)+1;
          if(client){
            for(const r of next.requests.filter(r=>r.completedAt&&!r.archived)){
              await client.query('insert into phone_cloud_managed_lookup_results(state_key,lookup_id,client_id,idempotency_key,completed_at,data) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(state_key,lookup_id) do nothing',[key,r.lookupId,r.clientId,r.idempotencyKey,r.completedAt,JSON.stringify(r)]);r.archived=true;
            }
            // An unconfirmed stop must retain its phone binding even after
            // more than256 unrelated results have completed and been archived.
            const keep=new Set([...next.requests.filter(r=>r.completedAt).slice(-256).map(r=>r.lookupId),...next.channels.map(c=>c.requestId).filter(Boolean)]);next.requests=next.requests.filter(r=>!r.completedAt||keep.has(r.lookupId));
            await client.query('update phone_cloud_managed_lookup set data=$2::jsonb, updated_at=now() where state_key=$1',[key,JSON.stringify(next)]);await client.query('commit');
          }
          else{if(persistLegacy)await persistLegacy();await saveFile(next);}
          value=next;for(const commit of commits)commit();return result;
        }catch(e){if(client)await client.query('rollback').catch(()=>{});for(const undo of rollbacks.reverse())undo();throw e;}finally{client?.release();}
      });tail=job.catch(()=>{});return job;
    },
    async close(){await tail;fenced=true;if(owner){await owner.query("select pg_advisory_unlock(hashtext('phone_cloud_managed_lookup'),hashtext($1))",[key]).catch(()=>{});owner.release();}else if(lockFile)await fs.unlink(lockFile).catch(()=>{});}
  };
}
