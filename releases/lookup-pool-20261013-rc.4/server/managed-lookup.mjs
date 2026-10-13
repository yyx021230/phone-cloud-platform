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
  return {
    store,
    reserved:deviceId=>occupied.get(deviceId),
    async configure(input,actor){
      if(!input||typeof input!=='object'||Array.isArray(input))throw managedLookupError('invalid_pool_config');
      return store.transact(async (s,tx)=>{
        if(input.expectedConfigRevision!==undefined&&input.expectedConfigRevision!==(s.configRevision||0))throw managedLookupError('pool_config_changed',409);
        for(const [k,min,max] of [['concurrency',1,5],['waitMs',100,180000],['idleMs',100,300000],['queueLimit',1,1000],['clientQueueLimit',1,200],['waiterLimit',1,20],['humanLimit',0,5],['humanWaitMs',100,1800000]])if(input[k]!==undefined)s.config[k]=integer(input[k],min,max);
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
        const old=s.requests.find(r=>r.clientId===clientId&&r.idempotencyKey===key)||await tx.archived(clientId,key);
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
      tickPromise=store.transact(async(s,tx)=>{
        // A removed reservation stays published until this transaction commits.
        // Reacquiring it here would conflict and roll back other phones too.
        const releasedDevices=new Set();
        for(const c of [...s.channels]){
          const r=s.requests.find(r=>r.lookupId===c.requestId);
          const o=adapter.observe(c);
          if(r?.cancelRequested&&c.phase!=='stopping'){if(!adapter.canStop(c)){c.phase='unknown';continue;}if(channelActive(c)||activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}continue;}
          if(c.phase==='stopping'){
            if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);if(r&&!DONE.has(r.status))finish(r,r.cancelRequested?'cancelled':'failed',r.cancelRequested?(r.cancelReason||'lookup_cancelled'):'lookup_execution_failed');}
            continue;
          }
          if(o.unknown){c.phase='unknown';if(r&&!DONE.has(r.status))r.status='unknown';continue;}
          if(o.busy){c.phase=o.switching?'switching':c.phase==='starting'?'starting':'querying';if(r&&!DONE.has(r.status))r.status=c.phase==='starting'?'preparing':'running';continue;}
          if(o.human){c.phase='human';c.humanSince=c.humanSince||now();if(r&&!DONE.has(r.status)){r.status='waiting_human';if(now()-c.humanSince>=s.config.humanWaitMs){r.cancelRequested=true;r.cancelReason='lookup_manual_wait_expired';}}continue;}
          if(o.recovery){c.phase='recovery';if(r&&!DONE.has(r.status)){r.status='needs_recovery';r.code='lookup_recovery_required';}continue;}
          if(o.result&&r&&!DONE.has(r.status)){
            if(o.result.status==='succeeded'||o.result.status==='not_found'){r.name=o.result.name||'';finish(r,o.result.status);c.requestId='';c.phase='idle';c.idleAt=now();}
            else if(o.exhausted){finish(r,'failed','lookup_accounts_cooling');await adapter.stop(c,tx);c.phase='stopping';}
            else {finish(r,'failed','lookup_execution_failed');await adapter.stop(c,tx);c.phase='stopping';}
            continue;
          }
          if(o.startFailed&&r){const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d){d.prepareFailureCount=Math.min(3,(d.prepareFailureCount||0)+1);d.quarantineUntil=now()+[30000,60000,120000][d.prepareFailureCount-1];}
            // Only failed preparation before any query can move to one other
            // device. A failed/unknown query is never replayed elsewhere.
            if(r.attempts.length<2&&!r.queryId){r.status='queued';c.requestId='';}else finish(r,'failed','lookup_prepare_failed');
            if(o.stopped)s.channels.splice(s.channels.indexOf(c),1);else{await adapter.stop(c,tx);c.phase='stopping';}continue;
          }
          if(o.ready&&r&&(c.phase==='starting'||(c.phase==='querying'&&!r.queryId&&!c.queryId))){if(!adapter.health(c.deviceId).ready)continue;const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d){d.prepareFailureCount=0;d.quarantineUntil=0;}await adapter.query(c,r,tx);c.phase='querying';r.status='running';continue;}
          if(c.phase==='resuming'&&o.ready){c.phase=r&&!DONE.has(r.status)?'starting':'idle';}
          if(c.phase==='idle'&&(!s.config.enabled||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled)||!authorized(s,c.clientId)||now()-c.idleAt>=s.config.idleMs)){
            if(activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}
          }
        }
        for(const r of s.requests.filter(r=>r.status==='queued')){
          if(!authorized(s,r.clientId)||!adapter.clientValid(r.clientId))finish(r,'failed','permission_revoked');
          else if(now()>=r.deadline)finish(r,'expired','lookup_queue_timeout');
        }
        if(!s.config.enabled)return;
        const humanCount=s.channels.filter(c=>c.phase==='human').length;if(humanCount>0&&humanCount>=s.config.humanLimit)return;
        const waiting=s.requests.filter(r=>r.status==='queued');const clients=[...new Set(waiting.map(r=>r.clientId))];const last=clients.indexOf(s.lastClient);const order=last<0?clients:[...clients.slice(last+1),...clients.slice(0,last+1)];
        while(activeCount(s)<s.config.concurrency&&waiting.length){
          let selected=null;
          for(const clientId of order){const r=waiting.find(r=>r.clientId===clientId);if(!r)continue;const used=new Set(r.attempts.map(a=>a.deviceId));
            const candidates=s.devices.filter(d=>d.enabled&&!releasedDevices.has(d.deviceId)&&!(d.quarantineUntil>now())&&!used.has(d.deviceId)).map(d=>({d,c:s.channels.find(c=>c.deviceId===d.deviceId),h:adapter.health(d.deviceId)})).filter(x=>x.h.ready&&(!x.c||(x.c.phase==='idle'&&x.c.clientId===clientId))).sort((a,b)=>Number(!a.c)-Number(!b.c)||(a.d.lastUsedAt||0)-(b.d.lastUsedAt||0));
            if(candidates.length){selected={r,...candidates[0]};break;}
          }
          if(!selected)break;const {r,d}=selected;let c=selected.c;
          if(!c){c={deviceId:d.deviceId,deviceNumber:d.deviceNumber,clientId:r.clientId,generation:crypto.randomUUID(),requestId:r.lookupId,phase:'starting'};s.channels.push(c);await adapter.start(c,r,tx);r.status='preparing';}
          else{c.requestId=r.lookupId;await adapter.query(c,r,tx);c.phase='querying';r.status='running';}
          r.attempts.push({deviceId:d.deviceId,generation:c.generation,sessionId:c.sessionId,at:at()});d.lastUsedAt=now();s.lastClient=r.clientId;waiting.splice(waiting.indexOf(r),1);order.push(order.shift());
        }
      }).then(()=>syncOccupied()).finally(()=>{tickPromise=null;});return tickPromise;
    },
    async close(){closed=true;await tickPromise?.catch(()=>{});await store.close();}
  };
}
