import fs from 'node:fs/promises';
import path from 'node:path';
const key = value => String(value || '').trim().toUpperCase();
export async function createRecoveryIsolation({file, agentId, now=Date.now, write=async value=>{
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  const handle=await fs.open(tmp,'w',0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(tmp,file);
}}) {
  let state={version:1,agentId,targets:{}}, error='', chain=Promise.resolve(), corrupt=false;
  try {
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.version!==1 || saved.agentId!==agentId || !saved.targets || typeof saved.targets!=='object' || Array.isArray(saved.targets)) throw Error('invalid_isolation');
    for(const [serial,row] of Object.entries(saved.targets)) {
      if(!/^[A-Z0-9][A-Z0-9_.:-]{0,159}$/.test(serial) || !Number.isSafeInteger(row.failures) || row.failures<0 || !Number.isFinite(row.isolatedAt) || row.isolatedAt<0 || !Number.isSafeInteger(row.releaseRevision) || row.releaseRevision<0 || typeof row.reason!=='string') throw Error('invalid_isolation');
    }
    state=saved;
  } catch(e) { if(e.code!=='ENOENT'){corrupt=true;error='recovery_isolation_load_failed';} }
  function mutate(update, release=false) {
    const operation=chain.then(async()=>{
      if(corrupt) throw Error(error);
      const next=structuredClone(state);
      const result=update(next);
      if(!result) return [];
      if(!release) state=next; // Failure evidence blocks immediately, even if persistence fails.
      try { await write(next); state=next; error=''; return result; }
      catch { error='recovery_isolation_save_failed'; throw Error(error); }
    });
    chain=operation.catch(()=>{});return operation;
  }
  function row(value,serial) {return value.targets[serial] ||= {failures:0,isolatedAt:0,reason:'',releaseRevision:0,lastAttempt:''};}
  return {
    reason(serial) { return error || (state.targets[key(serial)]?.isolatedAt ? 'device_recovery_isolated' : ''); },
    health() { return {error,isolated:Object.entries(state.targets).filter(([,r])=>r.isolatedAt).map(([serial,r])=>({serial,failures:r.failures,reason:r.reason,isolatedAt:new Date(r.isolatedAt).toISOString()}))}; },
    failure(serial,attempt,reason='recovery_action_failed') {return mutate(next=>{
      const r=row(next,key(serial));if(r.lastAttempt===attempt || r.isolatedAt)return false;
      r.lastAttempt=attempt;r.failures++;if(r.failures>=3){r.isolatedAt=now();r.reason=reason;}return true;
    });},
    isolate(serial,reason='recovery_attempts_exhausted') {return mutate(next=>{const r=row(next,key(serial));if(r.isolatedAt)return false;r.isolatedAt=now();r.reason=reason;return true;});},
    confirmed(serial) {return mutate(next=>{const r=next.targets[key(serial)];if(!r || r.isolatedAt || !r.failures)return false;r.failures=0;r.lastAttempt='';return true;},true);},
    release(control) {return mutate(next=>{
      const changed=[];
      for(const item of control.releases || []) {
        const r=row(next,item.serial);
        if(item.revision<=r.releaseRevision)continue;
        Object.assign(r,{failures:0,isolatedAt:0,reason:'',lastAttempt:'',releaseRevision:item.revision});changed.push(item.serial);
      }
      return changed.length?changed:false;
    },true);}
  };
}
