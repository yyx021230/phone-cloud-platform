import {createManagedAsyncLookup,managedRequestByKey} from './managed-lookup-async.mjs';
import crypto from 'node:crypto';
import {LOOKUP_POOL_NUMBERS} from './managed-lookup-store.mjs';
const DONE=new Set(['succeeded','not_found','failed','expired','cancelled']);
const ACTIVE=new Set(['starting','querying','switching','stopping','resuming','unknown']);
export function managedLookupError(code,status=400){const e=new Error(code);e.statusCode=status;return e;}
export function managedLookupResponse(r) {
  if(r.status==='succeeded')return {status:200,body:{ok:true,name:r.name||''}};
  if(r.status==='not_found')return {status:200,body:{ok:true,name:'',code:'not_found'}};
  const code=r.code || (r.status==='waiting_human'?'lookup_manual_action_pending':r.status==='unknown'?'lookup_outcome_unknown':'lookup_timeout');
  const status=code==='permission_revoked'?403:code==='lookup_queue_timeout'||code==='lookup_timeout'?504:503;
  return {status,body:{ok:false,name:'',code}};
}
function integer(v,min,max){const n=Number(v);if(!Number.isInteger(n)||n<min||n>max)throw managedLookupError('invalid_pool_config');return n;}
const at=()=>new Date().toISOString();
export function createManagedLookupService({store,adapter,now=Date.now}) {
  let tickPromise=null,closed=false;
  const waiters=new Map();
  const finish=(r,status,code='')=>{r.status=status;r.code=code;r.completedAt=at();};
  const audit=(s,action,actor,detail={})=>{s.audits.push({action,actor,at:at(),...detail});s.audits=s.audits.slice(-1000);};
  const authorized=(s,clientId)=>s.grants.find(g=>g.clientId===clientId&&g.enabled);
  const channelActive=c=>ACTIVE.has(c.phase);
  const activeCount=s=>s.channels.filter(channelActive).length;
  const occupied=new Map();
  function syncOccupied(){occupied.clear();for(const c of store.snapshot().channels)occupied.set(c.deviceId,c);}
  syncOccupied();
  const asyncLookup=createManagedAsyncLookup({store,adapter,now});
  // Device work is committed independently. A channel never waits for another
  // phone to finish its lookup, and its failure cannot undo committed results.
  async function reconcileChannel(s,tx,c,releasedDevices){
    const r=s.requests.find(r=>r.lookupId===c.requestId);
    const o=adapter.observe(c);
    if(r?.mode==='async'&&!DONE.has(r.status)&&now()>=r.executionDeadline&&!r.cancelRequested){r.cancelRequested=true;r.cancelReason='lookup_processing_timeout';r.status='cancelling';}
    if(r?.cancelRequested&&c.phase!=='stopping'){if(!adapter.canStop(c)){c.phase='unknown';return;}if(channelActive(c)||activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}return;}
    if(c.phase==='stopping'){
      if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);if(r&&!DONE.has(r.status))finish(r,r.cancelRequested?'cancelled':'failed',r.cancelRequested?(r.cancelReason||'lookup_cancelled'):'lookup_execution_failed');}
      return;
    }
    if(o.unknown){c.phase='unknown';if(r&&!DONE.has(r.status))r.status='unknown';return;}
    if(o.busy){c.phase=o.switching?'switching':c.phase==='starting'?'starting':'querying';if(r&&!DONE.has(r.status))r.status=c.phase==='starting'?'preparing':'running';return;}
    if(o.human){c.phase='human';c.humanSince=c.humanSince||now();if(r&&!DONE.has(r.status)){r.status='waiting_human';if(now()-c.humanSince>=s.config.humanWaitMs){r.cancelRequested=true;r.cancelReason='lookup_manual_wait_expired';}}return;}
    if(o.recovery){c.phase='recovery';if(r&&!DONE.has(r.status)){r.status='needs_recovery';r.code='lookup_recovery_required';}return;}
    if(o.result&&r&&!DONE.has(r.status)){
      if(o.result.status==='succeeded'||o.result.status==='not_found'){r.name=o.result.name||'';finish(r,o.result.status);c.requestId='';c.phase='idle';c.idleAt=now();}
      else if(o.exhausted){finish(r,'failed','lookup_accounts_cooling');await adapter.stop(c,tx);c.phase='stopping';}
      else {finish(r,'failed','lookup_execution_failed');await adapter.stop(c,tx);c.phase='stopping';}
      return;
    }
    if(o.startFailed&&r){const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d){d.prepareFailureCount=Math.min(3,(d.prepareFailureCount||0)+1);d.quarantineUntil=now()+[30000,60000,120000][d.prepareFailureCount-1];}
      // Only failed preparation before any query can move to one other
      // device. A failed/unknown query is never replayed elsewhere.
      if(r.attempts.length<2&&!r.queryId){r.status='queued';c.requestId='';}else finish(r,'failed','lookup_prepare_failed');
      if(o.stopped)s.channels.splice(s.channels.indexOf(c),1);else{await adapter.stop(c,tx);c.phase='stopping';}return;
    }
    if(o.ready&&r&&(c.phase==='starting'||(c.phase==='querying'&&!r.queryId&&!c.queryId))){if(!adapter.health(c.deviceId).ready)return;const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d){d.prepareFailureCount=0;d.quarantineUntil=0;}await adapter.query(c,r,tx);c.phase='querying';r.status='running';return;}
    if(c.phase==='resuming'&&o.ready){c.phase=r&&!DONE.has(r.status)?'starting':'idle';}
    if(c.phase==='idle'&&(!s.config.enabled||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled)||!authorized(s,c.clientId)||now()-c.idleAt>=s.config.idleMs)){
      if(adapter.canStop(c)&&activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}
    }
  }
  function queuedExpired(s,r){return !authorized(s,r.clientId)||!adapter.clientValid(r.clientId)||now()>=r.deadline;}
  function expireQueued(s){
    for(const r of s.requests.filter(r=>r.status==='queued')){
      if(!authorized(s,r.clientId)||!adapter.clientValid(r.clientId))finish(r,'failed','permission_revoked');
      else if(now()>=r.deadline)finish(r,'expired','lookup_queue_timeout');
    }
  }
  function admissionAllowed(s){
    const humanCount=s.channels.filter(c=>c.phase==='human').length;
    return s.config.enabled&&activeCount(s)<s.config.concurrency&&!(humanCount>0&&humanCount>=s.config.humanLimit)&&s.requests.some(r=>r.status==='queued');
  }
  function unchangedChannel(s,c){
    const r=s.requests.find(r=>r.lookupId===c.requestId);
    if(r?.cancelRequested||(r?.mode==='async'&&!DONE.has(r.status)&&now()>=r.executionDeadline))return false;
    const o=adapter.observe(c);
    if(c.phase==='stopping')return !o.stopped;
    if(o.busy){const phase=o.switching?'switching':c.phase==='starting'?'starting':'querying';return c.phase===phase&&(!r||DONE.has(r.status)||r.status===(phase==='starting'?'preparing':'running'));}
    if(c.phase==='idle'&&!r&&!o.unknown&&!o.human&&!o.recovery){
      const retire=!s.config.enabled||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled)||!authorized(s,c.clientId)||now()-c.idleAt>=s.config.idleMs;
      return !retire||!adapter.canStop(c)||activeCount(s)>=s.config.concurrency;
    }
    return false;
  }
  return {
    submitAsync:asyncLookup.submit,
    getAsyncResult:asyncLookup.result,
    store,
    reserved:deviceId=>occupied.get(deviceId),
    async configure(input,actor){
      if(!input||typeof input!=='object'||Array.isArray(input))throw managedLookupError('invalid_pool_config');
      return store.transact(async (s,tx)=>{
        if(input.expectedConfigRevision!==undefined&&input.expectedConfigRevision!==(s.configRevision||0))throw managedLookupError('pool_config_changed',409);
        for(const [k,min,max] of [['concurrency',1,5],['waitMs',100,180000],['idleMs',100,300000],['queueLimit',1,1000],['clientQueueLimit',1,200],['waiterLimit',1,20],['humanLimit',0,5],['humanWaitMs',100,1800000],['asyncQueueWaitMs',100,3600000],['asyncTaskTtlMs',100,86400000],['asyncRecentResultMs',100,3600000],['asyncAliasLimit',1,100]])if(input[k]!==undefined)s.config[k]=integer(input[k],min,max);
        if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw managedLookupError('invalid_pool_config');s.config.enabled=input.enabled;}
        if(input.devices!==undefined){
          if(!Array.isArray(input.devices)||input.devices.length>49)throw managedLookupError('invalid_pool_devices');
          const ids=new Set(),numbers=new Set(),previous=s.devices;
          s.devices=input.devices.map(d=>{const n=Number(d.deviceNumber);if(!LOOKUP_POOL_NUMBERS.includes(n)||ids.has(d.deviceId)||numbers.has(n))throw managedLookupError('invalid_pool_devices');adapter.validateDevice(d.deviceId,n,previous.some(x=>x.deviceId===d.deviceId&&x.deviceNumber===n));ids.add(d.deviceId);numbers.add(n);const old=previous.find(x=>x.deviceId===d.deviceId);return {lastUsedAt:old?.lastUsedAt||0,quarantineUntil:old?.quarantineUntil||0,prepareFailureCount:old?.prepareFailureCount||0,deviceId:d.deviceId,deviceNumber:n,enabled:d.enabled===true};});
        }
        if(input.grants!==undefined){
          if(!Array.isArray(input.grants)||input.grants.length>100)throw managedLookupError('invalid_pool_grants');const seen=new Set();
          s.grants=input.grants.map(g=>{if(seen.has(g.clientId)||!adapter.clientValid(g.clientId)||!/^[A-Za-z0-9._:-]{8,160}$/.test(g.consentReference||''))throw managedLookupError('invalid_pool_grants');seen.add(g.clientId);return {clientId:g.clientId,enabled:g.enabled===true,consentReference:g.consentReference};});
        }
        s.configRevision=(s.configRevision||0)+1;audit(s,'pool_configuration',actor,{configRevision:s.configRevision});return {configRevision:s.configRevision};
      });
    },
    preview(){return LOOKUP_POOL_NUMBERS.map(n=>adapter.resolveNumber(n));},
    admin(){const s=store.snapshot();return {...s,clientOptions:adapter.clientOptions?.()||[],requests:s.requests.map(({phoneNumber,fingerprint,idempotencyKey,...r})=>({...r,hasName:Boolean(r.name)})),devices:s.devices.map(d=>({...d,health:d.quarantineUntil>now()?{ready:false,reason:'preparation_backoff',until:d.quarantineUntil}:adapter.health(d.deviceId),channel:s.channels.find(c=>c.deviceId===d.deviceId)||null})),counts:{registered:s.devices.length,executing:activeCount(s),waitingHuman:s.channels.filter(c=>c.phase==='human').length,queued:s.requests.filter(r=>r.status==='queued').length}};},
    async submit({clientId,phoneNumber,key}){
      if(!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw managedLookupError('idempotency_key_required');
      return store.transact(async (s,tx)=>{
        const grant=authorized(s,clientId);if(!grant||!adapter.clientValid(clientId))throw managedLookupError('managed_lookup_not_authorized',403);
        const fingerprint=crypto.createHash('sha256').update(phoneNumber).digest('hex');
        const old=await managedRequestByKey(s,tx,clientId,key);
        if(old){if(old.fingerprint!==fingerprint)throw managedLookupError('idempotency_conflict',409);return old.lookupId;}
        if(!s.config.enabled)throw managedLookupError('lookup_pool_disabled',503);
        const queued=s.requests.filter(r=>r.status==='queued');if(queued.length>=s.config.queueLimit||queued.filter(r=>r.clientId===clientId).length>=s.config.clientQueueLimit)throw managedLookupError('lookup_queue_full',429);
        const id=crypto.randomUUID();s.requests.push({lookupId:id,clientId,idempotencyKey:key,fingerprint,phoneNumber,consentReference:grant.consentReference,createdAt:at(),deadline:now()+s.config.waitMs,status:'queued',attempts:[],name:''});return id;
      });
    },
    async wait(lookupId,clientId,{signal}={}){
      const count=waiters.get(clientId)||0;const key=clientId+':'+lookupId;
      if(count>=store.snapshot().config.waiterLimit||(waiters.get(key)||0)>=3)throw managedLookupError('lookup_waiter_limit',429);
      waiters.set(clientId,count+1);waiters.set(key,(waiters.get(key)||0)+1);
      const until=now()+store.snapshot().config.waitMs;
      try{
        while(!closed&&!signal?.aborted){
          if(store.isFenced())throw managedLookupError('lookup_storage_unavailable',503);
          const r=await store.readRequest(lookupId,clientId);if(!r)throw managedLookupError('lookup_not_found',404);
          if(DONE.has(r.status))return managedLookupResponse(r);
          if(now()>=until)return managedLookupResponse(r);
          await new Promise(resolve=>{const t=setTimeout(end,50);function end(){clearTimeout(t);signal?.removeEventListener('abort',end);resolve();}signal?.addEventListener('abort',end,{once:true});});
        }
        throw managedLookupError('lookup_connection_closed',503);
      }finally{waiters.set(clientId,(waiters.get(clientId)||1)-1);waiters.set(key,(waiters.get(key)||1)-1);if(!waiters.get(clientId))waiters.delete(clientId);if(!waiters.get(key))waiters.delete(key);}
    },
    async beforeResume(sessionId){
      return store.transact(s=>{const c=s.channels.find(c=>c.sessionId===sessionId);if(!c)return false;const r=s.requests.find(r=>r.lookupId===c.requestId);if(!s.config.enabled||!r||r.cancelRequested||!authorized(s,c.clientId)||!adapter.clientValid(c.clientId)||!adapter.health(c.deviceId,{allowScreenControl:true}).ready||activeCount(s)>=s.config.concurrency)return false;c.phase='resuming';return true;}).then(result=>{syncOccupied();return result;});
    },
    async retry(lookupId,actor){
      await store.transact(async(s,tx)=>{
        const r=s.requests.find(r=>r.lookupId===lookupId),c=s.channels.find(c=>c.requestId===lookupId);
        if(!r||!c||c.phase!=='recovery'||r.status!=='needs_recovery')throw managedLookupError('managed_recovery_not_ready',409);
        if(!authorized(s,r.clientId)||!adapter.clientValid(r.clientId))throw managedLookupError('managed_lookup_not_authorized',403);
        if(activeCount(s)>=s.config.concurrency)throw managedLookupError('managed_lookup_capacity_busy',409);
        if(!adapter.health(c.deviceId).ready)throw managedLookupError('managed_lookup_device_not_ready',409);
        await adapter.query(c,r,tx,{recovery:true});c.phase=r.queryId?'querying':'starting';r.status='retrying';r.code='';audit(s,'lookup_retry_original',actor,{lookupId});
      });syncOccupied();
    },
    async cancel(lookupId,actor){
      await store.transact(async(s,tx)=>{const r=s.requests.find(r=>r.lookupId===lookupId);if(!r)throw managedLookupError('lookup_not_found',404);if(DONE.has(r.status))return;if(r.status==='queued')finish(r,'cancelled','lookup_cancelled');else{r.cancelRequested=true;r.status='cancelling';}audit(s,'lookup_cancel',actor,{lookupId});});syncOccupied();
    },
    tick(){
      if(tickPromise)return tickPromise;
      tickPromise=(async()=>{
        if(store.isFenced?.())throw new Error('managed_lookup_storage_fenced');
        const releasedDevices=new Set(),failedDevices=new Set(),errors=[];
        async function deviceTransaction(deviceId,operation){
          let operationError;
          try{
            const result=await store.transact(async(s,tx)=>{
              try{return await operation(s,tx);}catch(error){operationError=error;throw error;}
            });
            syncOccupied();return {ok:true,result};
          }catch(error){
            const id=typeof deviceId==='function'?deviceId():deviceId;
            // Transaction/owner failures are global storage failures: halt new
            // dispatch. Callback failures have rolled back only this device.
            if(!id||error!==operationError||error.code==='managed_lookup_persistence_failed'||store.isFenced?.())throw error;
            failedDevices.add(id);errors.push(error);return {ok:false};
          }
        }
        for(const original of store.snapshot().channels){
          const snapshot=store.snapshot(),current=snapshot.channels.find(c=>c.deviceId===original.deviceId&&c.generation===original.generation&&c.sessionId===original.sessionId);
          if(!current)continue;
          try{if(unchangedChannel(snapshot,current))continue;}catch(error){failedDevices.add(current.deviceId);errors.push(error);continue;}
          await deviceTransaction(current.deviceId,async(s,tx)=>{
            const c=s.channels.find(c=>c.deviceId===current.deviceId&&c.generation===current.generation&&c.sessionId===current.sessionId);
            if(c)await reconcileChannel(s,tx,c,releasedDevices);
          });
        }
        const snapshot=store.snapshot();
        if(snapshot.requests.some(r=>r.status==='queued'&&queuedExpired(snapshot,r)))await store.transact(expireQueued);
        // Each admission is also its own transaction, with a fresh capacity
        // check. A bad device is excluded for this tick, never tried forever.
        const budget=store.snapshot().devices.length+5;
        for(let attempt=0;attempt<budget&&admissionAllowed(store.snapshot());attempt++){
          let selectedDevice;
          const outcome=await deviceTransaction(()=>selectedDevice,async(s,tx)=>{
            expireQueued(s);if(!admissionAllowed(s))return false;
            const waiting=s.requests.filter(r=>r.status==='queued'),clients=[...new Set(waiting.map(r=>r.clientId))],last=clients.indexOf(s.lastClient);
            const order=last<0?clients:[...clients.slice(last+1),...clients.slice(0,last+1)];
            let selected;
            for(const clientId of order){
              const r=waiting.find(r=>r.clientId===clientId),used=new Set(r.attempts.map(a=>a.deviceId)),candidates=[];
              for(const d of s.devices){
                if(!d.enabled||releasedDevices.has(d.deviceId)||failedDevices.has(d.deviceId)||d.quarantineUntil>now()||used.has(d.deviceId))continue;
                const c=s.channels.find(c=>c.deviceId===d.deviceId);if(c&&!(c.phase==='idle'&&c.clientId===clientId))continue;
                try{if(adapter.health(d.deviceId).ready)candidates.push({d,c});}catch(error){failedDevices.add(d.deviceId);errors.push(error);}
              }
              candidates.sort((a,b)=>Number(!a.c)-Number(!b.c)||(a.d.lastUsedAt||0)-(b.d.lastUsedAt||0));
              if(candidates.length){selected={r,...candidates[0]};break;}
            }
            if(!selected)return false;
            const {r,d}=selected;let c=selected.c;selectedDevice=d.deviceId;
            if(!c){c={deviceId:d.deviceId,deviceNumber:d.deviceNumber,clientId:r.clientId,generation:crypto.randomUUID(),requestId:r.lookupId,phase:'starting'};s.channels.push(c);await adapter.start(c,r,tx);r.status='preparing';}
            else{c.requestId=r.lookupId;await adapter.query(c,r,tx);c.phase='querying';r.status='running';}
            r.attempts.push({deviceId:d.deviceId,generation:c.generation,sessionId:c.sessionId,at:at()});d.lastUsedAt=now();s.lastClient=r.clientId;return true;
          });
          if(outcome.ok&&!outcome.result)break;
        }
        if(errors.length)throw new AggregateError(errors,'managed_lookup_device_errors');
      })().finally(()=>{tickPromise=null;});return tickPromise;
    },
    async close(){closed=true;await tickPromise?.catch(()=>{});await store.close();}
  };
}
