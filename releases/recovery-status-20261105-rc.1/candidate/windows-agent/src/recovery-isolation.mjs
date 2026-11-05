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
  // Proof belongs to this process and this incident, never to a cached file.
  const stable = new Map();
  let lastObservation = 0, observationPending = false;
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
    observeAdb(snapshot, {minStableMs=90_000,minStableScans=3,maxAgeMs=30_000,maxGapMs=45_000}={}) {
      // Bound queued work if disk I/O stalls. Skipped scans never count as proof.
      if(observationPending)return Promise.resolve([]);
      // Copy only direct discovery fields before publication adds physical rows.
      const observedAt=snapshot?.observedAt;
      const devices=Array.isArray(snapshot?.devices)
        ? snapshot.devices.map(d=>({serial:key(d?.adbSerial),state:d?.state})) : null;
      observationPending=true;
      return mutate(next=>{
        const at=now();
        if(!devices || !Number.isFinite(observedAt) || observedAt<=0
          || !Number.isFinite(at) || observedAt>at || at-observedAt>maxAgeMs
          || !Number.isFinite(minStableMs) || minStableMs<90_000
          || !Number.isSafeInteger(minStableScans) || minStableScans<3
          || !Number.isFinite(maxAgeMs) || maxAgeMs<=0
          || !Number.isFinite(maxGapMs) || maxGapMs<=0 || observedAt<lastObservation) {
          stable.clear();return false;
        }
        if(observedAt===lastObservation)return false;
        if(lastObservation && observedAt-lastObservation>maxGapMs)stable.clear();
        lastObservation=observedAt;
        const states=new Map();
        for(const d of devices) {
          if(!d.serial)continue;
          states.set(d.serial,states.has(d.serial)?'ambiguous':d.state);
        }
        const changed=[];
        for(const [serial,r] of Object.entries(next.targets)) {
          if((!r.isolatedAt && !r.failures) || states.get(serial)!=='device') {stable.delete(serial);continue;}
          const incident=JSON.stringify([r.isolatedAt,r.failures,r.lastAttempt,r.reason,r.releaseRevision]);
          const old=stable.get(serial);
          const proof=old?.incident===incident ? {...old,scans:old.scans+1} : {incident,startedAt:observedAt,scans:1};
          stable.set(serial,proof);
          if(proof.scans<minStableScans || observedAt-proof.startedAt<minStableMs)continue;
          if(r.isolatedAt)r.lastIsolation={isolatedAt:r.isolatedAt,reason:r.reason,failures:r.failures,lastAttempt:r.lastAttempt};
          Object.assign(r,{failures:0,isolatedAt:0,reason:'',lastAttempt:'',recoveredAt:observedAt});
          changed.push(serial);
        }
        // Release revision and manual pause (a separate store) are untouched.
        // mutate(...,true) exposes the clear only after durable write succeeds.
        return changed.length?changed:false;
      },true).finally(()=>{observationPending=false;});
    },
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
