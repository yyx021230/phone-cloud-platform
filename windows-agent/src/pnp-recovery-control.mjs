import fs from 'node:fs/promises';
import path from 'node:path';
export const RECOVERY_CONTROL_PROTOCOL='device_recovery_control_v1';
function parse(value){
  if(value?.protocol!==RECOVERY_CONTROL_PROTOCOL || !Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.paused)||value.paused.length>500)throw Error('invalid_recovery_control');
  if(value.releases!==undefined){
    if(!Array.isArray(value.releases)||value.releases.length>500)throw Error('invalid_recovery_releases');
    const released=new Set();for(const row of value.releases){if(typeof row.serial!=='string'||!/^[A-Z0-9][A-Z0-9_.:-]{0,159}$/.test(row.serial)||released.has(row.serial)||!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>value.revision)throw Error('invalid_recovery_releases');released.add(row.serial);}
  }
  const keys=new Set();for(const row of value.paused){if(typeof row.serial!=='string'||!/^[A-Z0-9][A-Z0-9_.:-]{0,159}$/.test(row.serial)||keys.has(row.serial)||typeof row.reason!=='string'||row.reason.length>200)throw Error('invalid_recovery_control');keys.add(row.serial);}
  return structuredClone(value);
}
export async function createPnpRecoveryControl({file,agentId,write=async value=>{
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;
  const handle=await fs.open(tmp,'w',0o600);
  try{await handle.writeFile(JSON.stringify({agentId,control:value}));await handle.sync();}finally{await handle.close();}
  await fs.rename(tmp,file);
}}){
  let committed={protocol:RECOVERY_CONTROL_PROTOCOL,revision:0,paused:[]},synced=false,error='',extraHolds=new Map(),chain=Promise.resolve();
  try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(saved.agentId!==agentId)throw Error('recovery_control_agent_mismatch');committed=parse(saved.control);}
  catch(e){if(e.code!=='ENOENT')error='recovery_control_load_failed';}
  const reason=serial=>!synced ? 'recovery_controls_not_synced' :
    [...committed.paused.map(x=>x.serial),...extraHolds.keys()].includes(String(serial).trim().toUpperCase()) ? 'device_recovery_paused' : '';
  return {
    reason,
    paused:()=>structuredClone(committed.paused),
    health:()=>({protocol:RECOVERY_CONTROL_PROTOCOL,revision:synced?committed.revision:-1,synced,error}),
    apply(value){
      // Block newly requested pauses immediately, including while disk I/O waits.
      let next;try{next=parse(value);}catch(e){error='invalid_recovery_control';return Promise.reject(e);}
      if(next.revision>=committed.revision)for(const x of next.paused)extraHolds.set(x.serial,Math.max(extraHolds.get(x.serial)||0,next.revision));
      const operation=chain.then(async()=>{
        if(next.revision<committed.revision)throw Error('stale_recovery_control');
        if(next.revision===committed.revision && JSON.stringify(next)!==JSON.stringify(committed))throw Error('conflicting_recovery_control');
        if(next.revision!==committed.revision || !synced)await write(next);
        committed=next;synced=true;error='';
        // Do not release holds from a newer update already queued behind us.
        for(const [key,revision] of extraHolds)if(revision<=next.revision)extraHolds.delete(key);
        return this.health();
      });
      chain=operation.catch(()=>{error='recovery_control_apply_failed';});return operation;
    }
  };
}
