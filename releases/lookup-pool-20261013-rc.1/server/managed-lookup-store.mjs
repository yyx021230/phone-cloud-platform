import fs from 'node:fs/promises';
import path from 'node:path';

export const LOOKUP_POOL_NUMBERS = Object.freeze([51,52,54,55,87,138,152,188,172,156,155,115,60,58,164,163,154,6,57,10,183,82,86,121,146,149,153,181,182,162,161,142,74,78,79,118,130,157,147,101,107,165,112,67,53,128,158,143,148]);
export const MANAGED_LOOKUP_PROTOCOL = 'managed_lookup_v1';
export function initialManagedLookupState() {
  return {version:1, revision:0, config:{enabled:false, concurrency:5, waitMs:120000, idleMs:120000, queueLimit:1000, clientQueueLimit:200, waiterLimit:20, humanLimit:5}, devices:[], grants:[], requests:[], channels:[], audits:[], lastClient:''};
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
    isFenced:()=>fenced,
    async transact(operation){
      const job=tail.then(async()=>{
        if(fenced)throw new Error('managed_lookup_storage_fenced');
        let client;const rollbacks=[];
        try{
          if(getPool){client=await (await getPool()).connect();await client.query('begin');const rows=await client.query('select data from phone_cloud_managed_lookup where state_key=$1 for update',[key]);if(!rows.rows.length)throw new Error('managed_lookup_state_missing');value=rows.rows[0].data;}
          const next=structuredClone(value);
          const result=await operation(next,{client,onRollback:fn=>rollbacks.push(fn), archived:async(clientId,requestKey)=>client?(await client.query('select data from phone_cloud_managed_lookup_results where state_key=$1 and client_id=$2 and idempotency_key=$3',[key,clientId,requestKey])).rows[0]?.data:null});
          next.revision=(value.revision||0)+1;
          if(client){
            for(const r of next.requests.filter(r=>r.completedAt&&!r.archived)){
              await client.query('insert into phone_cloud_managed_lookup_results(state_key,lookup_id,client_id,idempotency_key,completed_at,data) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(state_key,lookup_id) do nothing',[key,r.lookupId,r.clientId,r.idempotencyKey,r.completedAt,JSON.stringify(r)]);r.archived=true;
            }
            const keep=new Set(next.requests.filter(r=>r.completedAt).slice(-256).map(r=>r.lookupId));next.requests=next.requests.filter(r=>!r.completedAt||keep.has(r.lookupId));
            await client.query('update phone_cloud_managed_lookup set data=$2::jsonb, updated_at=now() where state_key=$1',[key,JSON.stringify(next)]);await client.query('commit');
          }
          else{if(persistLegacy)await persistLegacy();await saveFile(next);}
          value=next;return result;
        }catch(e){if(client)await client.query('rollback').catch(()=>{});for(const undo of rollbacks.reverse())undo();throw e;}finally{client?.release();}
      });tail=job.catch(()=>{});return job;
    },
    async close(){await tail;fenced=true;if(owner){await owner.query("select pg_advisory_unlock(hashtext('phone_cloud_managed_lookup'),hashtext($1))",[key]).catch(()=>{});owner.release();}else if(lockFile)await fs.unlink(lockFile).catch(()=>{});}
  };
}
