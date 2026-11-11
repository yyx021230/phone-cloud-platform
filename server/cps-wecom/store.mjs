import fs from 'node:fs/promises';
import path from 'node:path';
const initial=()=>({version:2,revision:0,executionMode:null,leads:[],nonces:[],recipients:[],limits:[]});
function validate(v) {
  if(!v||v.version!==2||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.leads)||!Array.isArray(v.nonces)||v.leads.length>10000||v.nonces.length>10000||!Array.isArray(v.recipients)||v.recipients.length>10000||!Array.isArray(v.limits)||v.limits.length>10000||![null,'send','preview'].includes(v.executionMode))throw Error('cps_store_schema_invalid');
  const ids=new Set();for(const r of v.leads){const k=JSON.stringify([r.appId,r.leadId]);if(ids.has(k)||typeof r.appId!=='string'||!/^[1-9]\d{0,18}$/.test(r.leadId)||BigInt(r.leadId)>9223372036854775807n||!/^[a-f0-9]{64}$/.test(r.fingerprint))throw Error('cps_store_schema_invalid');ids.add(k);}
  const nonces=new Set();for(const n of v.nonces){if(!/^[a-f0-9]{64}$/.test(n.key)||!Number.isSafeInteger(n.expiresAt)||nonces.has(n.key))throw Error('cps_store_schema_invalid');nonces.add(n.key);}
  const recipients=new Set();for(const r of v.recipients){if(!/^[a-f0-9]{64}$/.test(r.key)||r.physicalKey!==undefined&&!/^[a-f0-9]{64}$/.test(r.physicalKey)||recipients.has(r.key)||!ids.has(JSON.stringify([r.appId,r.leadId]))||!['reserved','submission_unknown','submitted','unknown','request_confirmed','already_contact','not_sent'].includes(r.state))throw Error('cps_store_schema_invalid');recipients.add(r.key);}
  for(const r of v.leads)if(!recipients.has(r.recipientKey))throw Error('cps_store_schema_invalid');
  const limits=new Set();for(const r of v.limits){if(!/^[a-f0-9]{64}$/.test(r.key)||limits.has(r.key)||(r.until!==null&&!Number.isSafeInteger(r.until)))throw Error('cps_store_schema_invalid');limits.add(r.key);}
  return v;
}
export async function createStore({file,getPool,key='default'}={}) {
  let owner,lock,fd,value,tail=Promise.resolve(),fenced=false;
  if(getPool) {
    owner=await (await getPool()).connect();owner.on('error',()=>{fenced=true;});
    try {
      const r=await owner.query("select pg_try_advisory_lock(hashtext('phone_cloud_cps_wecom'),hashtext($1)) as locked",[key]);
      if(!r.rows[0].locked)throw Error('cps_coordinator_already_active');
      await owner.query('insert into phone_cloud_cps_wecom(state_key,data) values($1,$2::jsonb) on conflict do nothing',[key,JSON.stringify(initial())]);
      value=validate((await owner.query('select data from phone_cloud_cps_wecom where state_key=$1',[key])).rows[0]?.data);
    }catch{await owner.query("select pg_advisory_unlock(hashtext('phone_cloud_cps_wecom'),hashtext($1))",[key]).catch(()=>{});owner.release();throw Error('cps_store_start_failed');}
  } else {
    if(!file)throw Error('cps_store_file_required');await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});lock=file+'.owner';
    // A stale file requires explicit operator investigation. Never steal a lock
    // based only on PID existence or silently discard a previous journal.
    try {fd=await fs.open(lock,'wx',0o600);await fd.writeFile(JSON.stringify({pid:process.pid}));await fd.sync();}
    catch{throw Error('cps_coordinator_lock_unavailable');}
    try {try{value=validate(JSON.parse(await fs.readFile(file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;value=initial();}}
    catch{await fd.close();await fs.unlink(lock);throw Error('cps_store_start_failed');}
  }
  return {
    snapshot:()=>structuredClone(value),
    fenced:()=>fenced,
    transact(fn) {
      const work=tail.then(async()=>{
        if(fenced)throw Error('cps_store_fenced');const next=structuredClone(value);const result=await fn(next);next.revision++;validate(next);
        try {
          if(owner){const r=await owner.query('update phone_cloud_cps_wecom set data=$3::jsonb,updated_at=now() where state_key=$1 and (data->>\'revision\')::bigint=$2',[key,value.revision,JSON.stringify(next)]);if(r.rowCount!==1)throw Error('cps_store_revision_conflict');}
          else {const tmp=file+'.tmp';const out=await fs.open(tmp,'w',0o600);try{await out.writeFile(JSON.stringify(next));await out.sync();}finally{await out.close();}await fs.rename(tmp,file);const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
        }catch{fenced=true;throw Error('cps_store_commit_unknown');}
        value=next;return result;
      });tail=work.catch(()=>{});return work;
    },
    async close() {await tail;fenced=true;if(owner){await owner.query("select pg_advisory_unlock(hashtext('phone_cloud_cps_wecom'),hashtext($1))",[key]).catch(()=>{});owner.release();}else{await fd.close();await fs.unlink(lock);}}
  };
}
