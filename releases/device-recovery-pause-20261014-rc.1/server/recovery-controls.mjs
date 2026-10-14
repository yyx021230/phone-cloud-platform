import fs from 'node:fs/promises';
import path from 'node:path';

export const RECOVERY_CONTROL_PROTOCOL = 'device_recovery_control_v1';
const empty = () => ({protocol:RECOVERY_CONTROL_PROTOCOL, revision:0, paused:[]});
const fail = (message, statusCode=400) => Object.assign(new Error(message), {statusCode});
export function recoverySerial(value) {
  if(typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(value.trim())) throw fail('invalid_recovery_serial');
  return value.trim().toUpperCase();
}
export function normalizeRecoveryControlAck(input={}) {
  return {protocol:input.protocol===RECOVERY_CONTROL_PROTOCOL ? RECOVERY_CONTROL_PROTOCOL : '',
    revision:Number.isSafeInteger(input.revision) && input.revision>=0 ? input.revision : -1,
    synced:input.synced===true, error:String(input.error||'').slice(0,80)};
}
// Single cloud-process control store, independent of delayed runtime snapshots.
// Publish desired state only after durable atomic replacement; no partial ACK.
export async function createRecoveryControls({file, write=async value=>{
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  const handle=await fs.open(tmp,'w',0o600);
  try {await handle.writeFile(JSON.stringify(value));await handle.sync();} finally {await handle.close();}
  await fs.rename(tmp,file);
}}) {
  let state={schema:1,agents:{}},loadFailed=false;
  try {
    try {state=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(state.schema!==1 || !state.agents || typeof state.agents!=='object' || Array.isArray(state.agents))throw Error('invalid_recovery_controls_store');
    for(const value of Object.values(state.agents))validate(value);
  } catch {loadFailed=true;}
  // A damaged recovery file must not take down unrelated platform services.
  // Invalid revision prevents Agent admission; never silently replace it.

  let pending=Promise.resolve();
  const get=id=>loadFailed ? {protocol:RECOVERY_CONTROL_PROTOCOL,revision:-1,paused:[],error:"recovery_controls_unavailable"} : structuredClone(Object.hasOwn(state.agents,id)?state.agents[id]:empty());
  return {get, set(id,input) {
    const operation=pending.then(async()=>{
      if(loadFailed)throw fail("recovery_controls_unavailable",503);
      const serial=recoverySerial(input.adbSerial);
      if(typeof input.paused!=='boolean')throw fail('paused_must_be_boolean');
      const current=get(id);
      if(input.expectedRevision!==current.revision)throw fail('recovery_control_revision_conflict',409);
      const reason=String(input.reason||'管理员暂停自动恢复').trim();
      if(reason.length>200 || /[\x00-\x1f]/.test(reason))throw fail('invalid_recovery_pause_reason');
      const previous=current.paused.find(x=>x.serial===serial);
      if(Boolean(previous)===input.paused && (!input.paused || previous.reason===reason))return current;
      const paused=current.paused.filter(x=>x.serial!==serial);
      if(input.paused)paused.push({serial,reason,updatedAt:new Date().toISOString()});
      if(paused.length>500)throw fail('too_many_recovery_pauses');
      const next={protocol:RECOVERY_CONTROL_PROTOCOL,revision:current.revision+1,paused};
      validate(next);
      const copy=structuredClone(state);Object.defineProperty(copy.agents,id,{value:next,enumerable:true,writable:true,configurable:true});
      await write(copy);state=copy;return get(id);
    });
    pending=operation.catch(()=>{});return operation;
  }};
}
function validate(value){
  if(value?.protocol!==RECOVERY_CONTROL_PROTOCOL || !Number.isSafeInteger(value.revision) || value.revision<0 || !Array.isArray(value.paused) || value.paused.length>500)throw Error('invalid_recovery_control');
  const keys=new Set();for(const row of value.paused){const serial=recoverySerial(row.serial);if(serial!==row.serial||keys.has(serial)||typeof row.reason!=='string'||row.reason.length>200)throw Error('invalid_recovery_pause');keys.add(serial);}
}
