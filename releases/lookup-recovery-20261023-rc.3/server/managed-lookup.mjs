import {ROUND_IDLE_MS,roundIdleNeedsSync,syncRoundIdle} from './lookup-round-idle.mjs';
import {requestRoundStop,expireIdleRound,settleRoundStops,roundStopRequested,ROUND_STOP_OFFLINE_GRACE_MS} from './lookup-round-stop.mjs';
import {lookupDeviceUnavailable,preparationBlocked,recordLookupPreparationFailure,recordLookupPreparationSuccess,resetLookupUnavailable} from './lookup-device-availability.mjs';
import {createManagedAsyncLookup,managedRequestByKey} from './managed-lookup-async.mjs';
import crypto from 'node:crypto';
import {recordAccountOffline,pendingAccountOfflineNotifications} from './lookup-account-offline.mjs';
import {createLookupReadiness,PREPARED_PROTOCOL} from './lookup-readiness.mjs';
import {LOOKUP_POOL_NUMBERS} from './managed-lookup-store.mjs';
const DONE=new Set(['succeeded','not_found','failed','expired','cancelled']);
const OFFLINE_HANDOFF_GRACE_MS=30000;
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
export function createManagedLookupService({store,adapter,now=Date.now,probePhone='',preparationIdleMs=ROUND_IDLE_MS,resumeHuman,aiEnabled=false}) {
  let tickPromise=null,closed=false;
  const waiters=new Map();
  const finish=(r,status,code='')=>{r.status=status;r.code=code;r.completedAt=at();};
  const audit=(s,action,actor,detail={})=>{s.audits.push({action,actor,at:at(),...detail});s.audits=s.audits.slice(-1000);};
  const authorized=(s,clientId)=>s.grants.find(g=>g.clientId===clientId&&g.enabled);
  const channelActive=c=>ACTIVE.has(c.phase);
  const activeCount=s=>s.channels.filter(channelActive).length;
  const occupiedCount=s=>s.channels.filter(c=>c.phase!=='quarantined').length;
  const observationOwner=crypto.randomUUID();
  const humanConfirmed=c=>c.humanObservation?.owner===observationOwner&&c.humanObservation?.confirmed===true&&now()-c.humanObservation.at>=0&&now()-c.humanObservation.at<=30000;
  const humanInspectionDue=c=>c.humanObservation?.owner===observationOwner&&now()-c.humanObservation.at>=0&&now()-c.humanObservation.at<=30000&&['unknown','loading','network_busy'].includes(c.humanObservation.state)&&!['device_busy','power_unavailable'].includes(c.humanObservation.reason)&&now()-c.humanObservation.stateSince>=60000;
  const humanActionable=c=>(humanConfirmed(c)||humanInspectionDue(c))&&(c.humanObservation.state==='search_ready'||!adapter.screenActive?.(c));
  const humanReplaceable=(s,c)=>c.phase==='human'&&!humanConfirmed(c)&&!humanInspectionDue(c)&&now()-(c.humanSince||now())>=120000
    &&!adapter.screenActive?.(c)&&adapter.canStop(c)&&!c.roundStopPreparationId
    &&s.devices.some(d=>d.deviceId!==c.deviceId&&d.enabled&&!lookupDeviceUnavailable(d)&&!d.accountOffline&&!(d.quarantineUntil>now())&&!s.channels.some(x=>x.deviceId===d.deviceId)&&adapter.health(d.deviceId).ready);
  const occupied=new Map();
  function syncOccupied(){occupied.clear();for(const c of store.snapshot().channels){if(c.humanObservation?.owner!==observationOwner)delete c.humanObservation;occupied.set(c.deviceId,c);}}
  syncOccupied();
  const readiness=createLookupReadiness({adapter,now,probePhone,idleMs:preparationIdleMs});
  const asyncLookup=createManagedAsyncLookup({store,adapter,now,readiness});
  function aiCandidate(s,lookupId){
    if(!aiEnabled)return null;
    const r=s.requests.find(x=>x.lookupId===lookupId),c=s.channels.find(x=>x.requestId===lookupId);
    if(!r||!c||r.purpose==='readiness_probe'||r.status!=='needs_recovery'||c.phase!=='recovery'||!c.pageCompatibilityRequired||r.resultProtocol!==PREPARED_PROTOCOL||r.cancelRequested||c.roundStopPreparationId||c.offlineHandoffAt!==undefined||r.queryId!==c.queryId||!c.queryId||!s.config.enabled||!authorized(s,r.clientId)||!adapter.clientValid(r.clientId)||roundStopRequested(s,r.clientId)||(r.mode==='async'&&now()>=r.executionDeadline)||adapter.screenActive?.(c)||!adapter.health(c.deviceId).ready||!c.queryIdentity||adapter.readinessIdentity(c)!==c.queryIdentity)return null;
    const o=adapter.observe(c);if(o.busy||o.unknown||o.human||o.accountOffline||o.exhausted||o.stopped||!o.recovery)return null;
    const evidence=adapter.aiEvidence?.(c,r);if(!evidence||o.recoveryFailure?.jobId!==evidence.jobId)return null;
    if(!evidence.evidenceId&&now()-evidence.completedMs<10000)return null;
    return {...evidence,lookupId:r.lookupId,queryId:c.queryId,sessionId:c.sessionId,deviceId:c.deviceId,generation:c.generation,phoneNumber:r.phoneNumber};
  }
  const sameAiBinding=(a,b)=>a&&b&&['lookupId','queryId','sessionId','deviceId','generation','jobId','taskId','evidenceId','evidenceSha256','phoneNumber'].every(k=>a[k]===b[k]);

  async function reconcileRoundIdle(){
    if(!roundIdleNeedsSync(store.snapshot(),now(),preparationIdleMs))return;
    await store.transact(s=>syncRoundIdle(s,now(),preparationIdleMs,p=>expireIdleRound(s,p,{now,finish,audit})));
    syncOccupied();
  }
  const matchesQuery=(r,c,o)=>Boolean(c.queryId&&o.result&&(!r.queryId||r.queryId===c.queryId)&&(!o.result.resultId||o.result.resultId===c.queryId));
  const completedResult=(r,c,o)=>matchesQuery(r,c,o)&&['succeeded','not_found'].includes(o.result.status);
  const reusableAfterResult=(c,o)=>!c.aiVision?.cleanup&&!c.roundStopPreparationId&&c.offlineHandoffAt===undefined&&c.offlineHandoffSince===undefined&&c.phase!=='stopping'&&!o.accountOffline&&!o.unknown&&!o.busy&&!o.human&&!o.recovery&&!o.startFailed&&o.ready!==false;
  function releaseCompleted(s,c,o,releasedDevices){
    if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);return true;}
    if(reusableAfterResult(c,o)){delete c.humanObservation;delete c.humanSince;c.requestId='';c.phase='idle';c.idleAt=now();return true;}
    return false;
  }
  // Device work is committed independently. A channel never waits for another
  // phone to finish its lookup, and its failure cannot undo committed results.
  async function reconcileChannel(s,tx,c,releasedDevices){
    const r=s.requests.find(r=>r.lookupId===c.requestId);
    const o=adapter.observe(c);
    if(aiEnabled&&o.recovery&&o.recoveryFailure?.domain==='page'&&r?.purpose!=='readiness_probe'&&c.readinessProof&&c.queryIdentity===adapter.readinessIdentity(c)&&c.readinessProof.identity===c.queryIdentity)c.aiReadinessProof=structuredClone(c.readinessProof);
    readiness.invalidate(s,c);
    // Preserve a received business result, but still isolate a proven login
    // loss even when the terminal session releases its reservation immediately.
    if(o.accountOffline&&!o.unknown&&!o.busy)recordAccountOffline(s,c,o.accountOffline,now());
    // An already received result belongs to this query even if cancellation,
    // a deadline or a pending stop races with this poll. Commit it separately
    // from fallible cleanup; retain the reservation until lifecycle is known.
    if(r&&!DONE.has(r.status)&&completedResult(r,c,o)){
      readiness.record(s,c,r,o);
      if(r.purpose==='readiness_probe'&&!readiness.valid(s,c)){
        finish(r,'failed','lookup_probe_result_mismatch');
        if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);}
        else if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}
        else c.phase='unknown';
        return;
      }
      r.name=o.result.name||'';finish(r,o.result.status);releaseCompleted(s,c,o,releasedDevices);return;
    }
    if(r&&['succeeded','not_found'].includes(r.status)&&releaseCompleted(s,c,o,releasedDevices))return;
    // End the caller's round independently of unreachable phone cleanup.
    // Offline is never a physical ACK: keep this generation reserved, cancel
    // its deliverable work durably, and only then detach it from round gating.
    if(c.roundStopPreparationId||c.offlineHandoffAt!==undefined){
      if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);if(r&&!DONE.has(r.status))finish(r,'cancelled','lookup_round_stopped');return;}
      if(adapter.isOffline?.(c)||!adapter.canStop(c)){
        c.roundStopOfflineSince??=now();
        if((c.roundStopDetachedAt===undefined||c.phase!=='quarantined')&&now()-c.roundStopOfflineSince>=ROUND_STOP_OFFLINE_GRACE_MS&&adapter.quarantineRoundStop){
          await adapter.quarantineRoundStop(c,tx);
          c.roundStopDetachedAt=now();c.phase='quarantined';
          if(r&&!DONE.has(r.status))finish(r,'cancelled','lookup_round_stopped');
          audit(s,'lookup_round_offline_quarantined','system',{deviceId:c.deviceId,preparationId:c.roundStopPreparationId,generation:c.generation});
        }
        return;
      }
      delete c.roundStopOfflineSince;
      if(c.phase!=='stopping'&&adapter.canStop(c)&&(channelActive(c)||activeCount(s)<s.config.concurrency)){await adapter.stop(c,tx);c.phase='stopping';}
      return;
    }
    // Losing transport does not end the customer's lookup. Fence only the
    // old phone attempt, retain its physical reservation, then enqueue the
    // SAME canonical request on another verified phone in this transaction.
    if(adapter.isOffline?.(c)){
      c.offlineHandoffSince??=now();delete c.readinessProof;delete c.readinessPriorityAt;
      if(now()-c.offlineHandoffSince<OFFLINE_HANDOFF_GRACE_MS||!adapter.quarantineRoundStop){c.phase='unknown';return;}
      await adapter.quarantineRoundStop(c,tx);
      c.offlineHandoffAt=now();c.phase='quarantined';c.offlineHandoffRequestId=c.requestId||'';
      if(r&&!DONE.has(r.status)){
        if(r.cancelRequested)finish(r,'cancelled',r.cancelReason||'lookup_cancelled');
        else if(r.purpose==='readiness_probe'){recordLookupPreparationFailure(s,c,r,now(),{domain:'device',code:'lookup_probe_device_offline'});finish(r,'failed','lookup_probe_device_offline');}
        else if(now()>=r.executionDeadline)finish(r,'expired','lookup_processing_timeout');
        else{
          r.recoveryExcludedDevices||=[];if(!r.recoveryExcludedDevices.includes(c.deviceId))r.recoveryExcludedDevices.push(c.deviceId);
          r.status='queued';r.code='';delete r.queryId;
          if(r.mode==='async')r.deadline=r.executionDeadline; // Original total budget, not the spent initial queue budget.
          audit(s,'lookup_reroute_device_offline','system',{lookupId:r.lookupId,deviceId:c.deviceId,queryId:c.queryId,generation:c.generation});
        }
      }
      c.requestId='';delete c.queryId;delete c.rerouteAfterStop;delete c.rerouteReason;return;
    }
    delete c.offlineHandoffSince;
    if(r?.mode==='async'&&!DONE.has(r.status)&&now()>=r.executionDeadline&&!r.cancelRequested){r.cancelRequested=true;r.cancelReason='lookup_processing_timeout';r.status='cancelling';}
    if(r?.cancelRequested&&c.phase!=='stopping'){if(!adapter.canStop(c)){c.phase='unknown';return;}if(channelActive(c)||activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}return;}
    if(c.phase==='stopping'){
      if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);if(r&&!DONE.has(r.status)){
        if(c.rerouteAfterStop&&!r.cancelRequested){
          // This is the same already-started lookup, not a new initial wait.
          // Preserve its original total deadline after the real stop ACK.
          if(r.mode==='async')r.deadline=r.executionDeadline;
          r.status='queued';r.code='';delete r.queryId;
          audit(s,c.rerouteReason||'lookup_reroute_confirmed_limit','system',{lookupId:r.lookupId,deviceId:c.deviceId,queryId:c.queryId});
        }
        else finish(r,r.cancelRequested?'cancelled':'failed',r.cancelRequested?(r.cancelReason||'lookup_cancelled'):'lookup_execution_failed');
      }}
      return;
    }
    if(o.unknown){c.phase='unknown';if(r&&!DONE.has(r.status))r.status='unknown';return;}
    if(o.busy){c.phase=o.switching?'switching':c.phase==='starting'?'starting':'querying';if(r&&!DONE.has(r.status))r.status=c.phase==='starting'?'preparing':'running';return;}
    // An idle, already-finished session can survive a brief transport loss.
    // Reconnect restores only probe eligibility, never its old readiness proof
    // or an unfinished/unknown business attempt.
    if(c.phase==='unknown'&&(!r||DONE.has(r.status))&&o.ready&&!o.human&&!o.recovery&&!o.accountOffline&&!o.exhausted&&!o.startFailed){
      c.phase='idle';c.requestId='';c.idleAt=now();delete c.queryId;return;
    }
    if(o.accountOffline){
      if(c.accountOfflineJobId!==o.accountOffline.jobId){
        recordAccountOffline(s,c,o.accountOffline,now());c.accountOfflineJobId=o.accountOffline.jobId;
        if(r&&!DONE.has(r.status)){
          if(r.purpose==='readiness_probe')finish(r,'failed','lookup_account_login_required');
          else {r.status='rerouting';r.code='';c.rerouteAfterStop=true;c.rerouteReason='lookup_reroute_account_offline';}
        }
      }
      // Release only after a terminal task/session or a confirmed stop.
      // Unknown or busy executions above never enter this replay path.
      if(o.stopped){c.phase='stopping';return;}
      if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}
      else c.phase='account_offline';
      return;
    }
    if(o.human&&humanReplaceable(s,c)&&activeCount(s)<s.config.concurrency){
      await adapter.stop(c,tx);c.phase='stopping';delete c.humanObservation;delete c.readinessProof;
      const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)d.quarantineUntil=Math.max(d.quarantineUntil||0,now()+300000);
      if(r&&!DONE.has(r.status)){
        if(r.purpose==='readiness_probe')finish(r,'cancelled','lookup_probe_human_replaced');
        else{r.status='rerouting';c.rerouteAfterStop=true;c.rerouteReason='lookup_reroute_human_wait';}
      }
      audit(s,'lookup_human_safe_replacement','system',{deviceId:c.deviceId,lookupId:r?.lookupId});return;
    }
    if(o.human){
      c.phase='human';c.humanResumePending=true;c.humanSince=c.humanSince||now();
      if(r&&!DONE.has(r.status)){
        r.status='waiting_human';
        if(now()-c.humanSince>=s.config.humanWaitMs&&!humanActionable(c)){
          if(r.resultProtocol===PREPARED_PROTOCOL&&r.purpose!=='readiness_probe'){
            // End only this phone's manual wait, not the original business ID.
            // A live operator or unknown execution is never preempted; the
            // original overall deadline/cancel path still bounds the request.
            if(!adapter.screenActive?.(c)&&adapter.canStop(c)&&activeCount(s)<s.config.concurrency){
              await adapter.stop(c,tx);c.phase='stopping';delete c.readinessProof;delete c.humanObservation;
              r.humanWaitExcludedDevices||=[];if(!r.humanWaitExcludedDevices.includes(c.deviceId))r.humanWaitExcludedDevices.push(c.deviceId);
              r.status='rerouting';r.code='';c.rerouteAfterStop=true;c.rerouteReason='lookup_reroute_human_wait_expired';
              const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)d.quarantineUntil=Math.max(d.quarantineUntil||0,now()+300000);
              audit(s,'lookup_human_wait_handoff','system',{lookupId:r.lookupId,deviceId:c.deviceId});
            }
          }else{r.cancelRequested=true;r.cancelReason='lookup_manual_wait_expired';}
        }
      }
      return;
    }
    // A confirmed lost-input state is recoverable on the same probe phone;
    // it is not an unknown page. Permit one normal resume with the unchanged
    // account/runtime identity, then retire the failed probe as before.
    const recoverProbeInput=o.recoveryFailure?.domain==='state'&&o.recoveryFailure?.jobId
      &&o.recoveryFailure.canResume!==false&&o.recoveryFailure.identity
      &&o.recoveryFailure.identity===(r?.attempts?.at(-1)?.readinessIdentity||c.queryIdentity)
      &&!(r?.automaticRecoveries||[]).some(a=>a.deviceId===c.deviceId);
    if(o.recovery&&o.postHumanPageUnknown&&r?.purpose==='readiness_probe'&&!recoverProbeInput){
      finish(r,'failed','lookup_probe_page_unsupported');delete c.readinessProof;
      const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)d.quarantineUntil=Math.max(d.quarantineUntil||0,now()+300000);
      if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}else c.phase='unknown';
      return;
    }
    if(o.recovery&&r?.purpose==='readiness_probe'&&o.recoveryFailure?.domain!=='page'&&!recoverProbeInput){recordLookupPreparationFailure(s,c,r,now(),adapter.preparationFailure?.(c));finish(r,'failed','lookup_probe_failed');if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}return;}
    if(o.recovery){
      c.phase='recovery';
      if(!r||DONE.has(r.status))return;
      r.status='needs_recovery';r.code='lookup_recovery_required';
      // A generic recovery flag is not proof that the previous task stopped.
      // Only the adapter's matching terminal query evidence permits automation.
      const failure=o.recoveryFailure;
      if(r.mode!=='async'||(r.resultProtocol!==PREPARED_PROTOCOL&&r.purpose!=='readiness_probe')||!failure?.jobId)return;
      if(!s.config.enabled||!authorized(s,c.clientId)||!adapter.clientValid(c.clientId)||!adapter.health(c.deviceId).ready||activeCount(s)>=s.config.concurrency)return;
      r.automaticRecoveries||=[];r.recoveryExcludedDevices||=[];
      const attempted=r.automaticRecoveries.some(a=>a.deviceId===c.deviceId);
      const identity=r.attempts?.at(-1)?.readinessIdentity||(r.purpose==='readiness_probe'?c.queryIdentity:'');
      if(failure.domain==='page'){
        // One read-only continuation of the original submitted input. A page
        // incompatibility never quarantines a phone or fans the same error
        // out across the fleet. Unknown layouts stay explicit and recoverable.
        const pageAttempted=r.automaticRecoveries.some(a=>a.deviceId===c.deviceId&&a.domain==='page');
        const sameIdentity=failure.identity&&failure.identity===(identity||c.queryIdentity);
        if(!pageAttempted&&sameIdentity){
          await adapter.query(c,r,tx,{recovery:true,automaticRecovery:true,prepared:true,probePhone:readiness.probePhone,verified:true,observationOnly:true});
          r.automaticRecoveries.push({deviceId:c.deviceId,jobId:failure.jobId,at:at(),domain:'page'});
          c.phase='querying';delete c.pageCompatibilityRequired;r.status='retrying';r.code='';
          audit(s,'lookup_page_observation_resume','system',{lookupId:r.lookupId,deviceId:c.deviceId,jobId:failure.jobId});
        }else if(r.purpose==='readiness_probe'){
          // A failed test-number observation cannot occupy one of five slots
          // until the business deadline. It grants no proof; retire safely.
          recordLookupPreparationFailure(s,c,r,now(),failure);
          finish(r,'failed','lookup_probe_page_unsupported');delete c.readinessProof;
          if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}
        }else{r.code='lookup_page_compatibility_required';c.pageCompatibilityRequired=true;}
        return;
      }
      // A terminal visual observation already exhausted its reader or overall
      // budget. Repeating the same frame adds another full local retry.
      // An exhausted Agent page recovery likewise leaves this phone instead
      // of repeating its local recovery. Other failures retain one resume.
      const visualExhausted=['local_lookup_result_unconfirmed:ocr_reader_timeout','local_lookup_result_unconfirmed:observation_budget_exhausted'].includes(failure.reason);
      const pageRecoveryExhausted=failure.reason==='poco_query_page_recovery_failed';
      if(failure.canResume!==false&&!visualExhausted&&!pageRecoveryExhausted&&!attempted&&failure.identity&&failure.identity===identity){
        // Once per physical phone, resume the original result/input. Never do
        // an intervening probe or a fresh-input restart on this recovery path.
        await adapter.query(c,r,tx,{recovery:true,automaticRecovery:true,prepared:true,probePhone:readiness.probePhone,verified:true});
        r.automaticRecoveries.push({deviceId:c.deviceId,jobId:failure.jobId,at:at()});
        c.phase='querying';r.status='retrying';r.code='';
        audit(s,'lookup_automatic_recovery','system',{lookupId:r.lookupId,deviceId:c.deviceId,jobId:failure.jobId});return;
      }
      // A second terminal failure (or changed account identity) leaves this
      // phone. Preserve the business ID and wait for a real stop ACK first.
      if(!adapter.canStop(c))return;
      await adapter.stop(c,tx);
      if(!r.recoveryExcludedDevices.includes(c.deviceId))r.recoveryExcludedDevices.push(c.deviceId);
      const device=s.devices.find(d=>d.deviceId===c.deviceId);
      if(device)device.quarantineUntil=Math.max(device.quarantineUntil||0,now()+(visualExhausted?300000:30000));
      delete c.readinessProof;delete c.readinessPriorityAt;c.phase='stopping';
      if(r.recoveryExcludedDevices.length>=3){r.cancelRequested=true;r.cancelReason='lookup_recovery_exhausted';r.status='cancelling';}
      else {r.status='rerouting';r.code='';c.rerouteAfterStop=true;c.rerouteReason='lookup_reroute_recovery_exhausted';}
      return;
    }
    if(r&&!DONE.has(r.status)&&matchesQuery(r,c,o)){
      if(o.exhausted&&o.result?.status==='limit_reached'&&r.resultProtocol===PREPARED_PROTOCOL){
        // The old execution is terminal, but retain the reservation until the
        // device acknowledges stop. Unknown execution is never replayed.
        const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)d.accountRepairAt=now();
        delete c.readinessProof;r.status='rerouting';c.rerouteAfterStop=true;
        if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}
      }
      else if(o.exhausted){if(o.result?.status==='limit_reached'){const d=s.devices.find(d=>d.deviceId===c.deviceId);if(d)d.accountRepairAt=now();}finish(r,'failed','lookup_accounts_cooling');await adapter.stop(c,tx);c.phase='stopping';}
      else {finish(r,'failed','lookup_execution_failed');await adapter.stop(c,tx);c.phase='stopping';}
      return;
    }
    if(r?.purpose==='readiness_probe'&&(o.recovery||o.startFailed)){recordLookupPreparationFailure(s,c,r,now(),adapter.preparationFailure?.(c));finish(r,'failed','lookup_probe_failed');if(o.stopped){s.channels.splice(s.channels.indexOf(c),1);releasedDevices.add(c.deviceId);}else if(adapter.canStop(c)){await adapter.stop(c,tx);c.phase='stopping';}return;}
    if(o.startFailed&&r){recordLookupPreparationFailure(s,c,r,now(),adapter.preparationFailure?.(c));
      // Only failed preparation before any query can move to one other
      // device. A failed/unknown query is never replayed elsewhere.
      if(r.attempts.length<2&&!r.queryId){r.status='queued';c.requestId='';}else finish(r,'failed','lookup_prepare_failed');
      if(o.stopped)s.channels.splice(s.channels.indexOf(c),1);else{await adapter.stop(c,tx);c.phase='stopping';}return;
    }
    if(o.ready&&r&&(c.phase==='starting'||(c.phase==='querying'&&!r.queryId&&!c.queryId))){if(!adapter.health(c.deviceId).ready)return;if(r.purpose!=='readiness_probe')recordLookupPreparationSuccess(s,c);await adapter.query(c,r,tx,{prepared:r.resultProtocol===PREPARED_PROTOCOL,probePhone:readiness.probePhone,verified:readiness.valid(s,c)});c.phase='querying';r.status='running';return;}
    if(c.phase==='resuming'&&o.ready){c.phase=r&&!DONE.has(r.status)?'starting':'idle';}
    if(c.phase==='idle'&&(!s.config.enabled||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled)||!authorized(s,c.clientId)||(now()-c.idleAt>=s.config.idleMs&&!readiness.keepWarm(s,c)))){
      if(adapter.canStop(c)&&activeCount(s)<s.config.concurrency){await adapter.stop(c,tx);c.phase='stopping';}
    }
  }
  function queuedExpired(s,r){return !authorized(s,r.clientId)||!adapter.clientValid(r.clientId)||now()>=r.deadline;}
  function expireQueued(s){
    for(const r of s.requests.filter(r=>r.status==='queued')){
      if(!authorized(s,r.clientId)||!adapter.clientValid(r.clientId))finish(r,'failed','permission_revoked');
      else if(now()>=r.deadline)finish(r,'expired',r.mode==='async'&&r.attempts?.length&&now()>=r.executionDeadline?'lookup_processing_timeout':'lookup_queue_timeout');
    }
  }
  function admissionAllowed(s){
    return s.config.enabled&&activeCount(s)<s.config.concurrency&&s.requests.some(r=>r.status==='queued');
  }
  function unchangedChannel(s,c){
    const r=s.requests.find(r=>r.lookupId===c.requestId);
    if(c.roundStopPreparationId||c.offlineHandoffAt!==undefined){
      const o=adapter.observe(c);
      if(o.stopped||(r&&!DONE.has(r.status)&&completedResult(r,c,o)))return false;
      if(adapter.isOffline?.(c)||!adapter.canStop(c)){
        if(c.roundStopOfflineSince===undefined)return false;
        return (c.roundStopDetachedAt!==undefined&&c.phase==='quarantined')||
          now()-c.roundStopOfflineSince<ROUND_STOP_OFFLINE_GRACE_MS||!adapter.quarantineRoundStop;
      }
      if(c.roundStopOfflineSince!==undefined)return false;
      return c.phase==='stopping'||(!channelActive(c)&&activeCount(s)>=s.config.concurrency);
    }
    if(adapter.isOffline?.(c)||c.offlineHandoffSince!==undefined)return false;
    if(c.readinessProof&&!readiness.valid(s,c))return false;
    if(r?.cancelRequested||(r?.mode==='async'&&!DONE.has(r.status)&&now()>=r.executionDeadline))return false;
    const o=adapter.observe(c);
    if(r&&!DONE.has(r.status)&&completedResult(r,c,o))return false;
    if(r&&['succeeded','not_found'].includes(r.status)&&(o.stopped||reusableAfterResult(c,o)))return false;
    if(c.phase==='stopping')return !o.stopped;
    if(o.accountOffline)return c.phase==='account_offline'&&!o.stopped&&!adapter.canStop(c);
    if(o.busy){const phase=o.switching?'switching':c.phase==='starting'?'starting':'querying';return c.phase===phase&&(!r||DONE.has(r.status)||r.status===(phase==='starting'?'preparing':'running'));}
    if(c.phase==='idle'&&!r&&!o.unknown&&!o.human&&!o.recovery){
      const retire=!s.config.enabled||!s.devices.some(d=>d.deviceId===c.deviceId&&d.enabled)||!authorized(s,c.clientId)||(now()-c.idleAt>=s.config.idleMs&&!readiness.keepWarm(s,c));
      return !retire||!adapter.canStop(c)||activeCount(s)>=s.config.concurrency;
    }
    return false;
  }
  return {
    async prepare(input){return store.transact(s=>{
      // Convert only a proven legacy three-login-failure isolation. A transport
      // or mixed failure history keeps the existing operator-reset circuit.
      for(const d of s.devices.filter(d=>lookupDeviceUnavailable(d)&&!d.accountOffline)){
        const evidence=adapter.legacyLoginIsolation?.(d.deviceId);
        if(evidence){recordAccountOffline(s,{deviceId:d.deviceId},evidence,now());resetLookupUnavailable(d);audit(s,'legacy_login_isolation_reclassified','system',{deviceId:d.deviceId,jobId:evidence.jobId});}
      }
      const freshKey=!(s.preparationKeys||[]).some(k=>k.clientId===input.clientId&&k.key===input.key);
      readiness.prepare(s,input);
      if(freshKey)for(const d of s.devices.filter(d=>lookupDeviceUnavailable(d)&&!d.accountOffline&&!s.channels.some(c=>c.deviceId===d.deviceId))){
        const evidence=adapter.legacyPageIsolation?.(d);
        if(evidence){resetLookupUnavailable(d);audit(s,'legacy_page_isolation_reclassified','system',{deviceId:d.deviceId,...evidence});}
      }
      return {...readiness.status(s,input.clientId),...readiness.submissionFeedback(s,input.clientId)};
    });},
    async stopRound(input){const out=await store.transact(s=>requestRoundStop(s,input,{adapter,now,finish,audit}));syncOccupied();return out;},
    accountOfflineNotifications(devices){return pendingAccountOfflineNotifications(store.snapshot(),devices);},
    submitAsync:asyncLookup.submit,
    getAsyncResult:asyncLookup.result,
    store,
    reserved:deviceId=>occupied.get(deviceId),
    async configure(input,actor){
      if(!input||typeof input!=='object'||Array.isArray(input))throw managedLookupError('invalid_pool_config');
      return store.transact(async (s,tx)=>{
        if(input.expectedConfigRevision!==undefined&&input.expectedConfigRevision!==(s.configRevision||0))throw managedLookupError('pool_config_changed',409);
        for(const [k,min,max] of [['concurrency',1,5],['waitMs',100,180000],['idleMs',100,300000],['queueLimit',1,1000],['clientQueueLimit',1,200],['preparedClientInflightLimit',1,200],['waiterLimit',1,20],['humanLimit',0,5],['humanWaitMs',100,1800000],['asyncQueueWaitMs',100,3600000],['asyncTaskTtlMs',100,86400000],['asyncRecentResultMs',100,3600000],['asyncAliasLimit',1,100]])if(input[k]!==undefined)s.config[k]=integer(input[k],min,max);
        if(input.enabled!==undefined){if(typeof input.enabled!=='boolean')throw managedLookupError('invalid_pool_config');s.config.enabled=input.enabled;}
        if(input.devices!==undefined){
          if(!Array.isArray(input.devices)||input.devices.length>49)throw managedLookupError('invalid_pool_devices');
          const ids=new Set(),numbers=new Set(),previous=s.devices;
          s.devices=input.devices.map(d=>{const n=Number(d.deviceNumber);if(!LOOKUP_POOL_NUMBERS.includes(n)||ids.has(d.deviceId)||numbers.has(n))throw managedLookupError('invalid_pool_devices');adapter.validateDevice(d.deviceId,n,previous.some(x=>x.deviceId===d.deviceId&&x.deviceNumber===n));ids.add(d.deviceId);numbers.add(n);const old=previous.find(x=>x.deviceId===d.deviceId);return {lastUsedAt:old?.lastUsedAt||0,lastBusinessSequence:old?.lastBusinessSequence||0,accountRepairAt:old?.accountRepairAt||0,lastReadinessSuccessAt:old?.lastReadinessSuccessAt||0,quarantineUntil:old?.quarantineUntil||0,prepareFailureCount:old?.prepareFailureCount||0,lookupUnavailable:old?.lookupUnavailable===true,lookupUnavailableAt:old?.lookupUnavailableAt||0,...(old?.accountOffline?{accountOffline:old.accountOffline}:{}),...(old?.preparationIssue?{preparationIssue:old.preparationIssue}:{}),...(old?.lastPreparationFailure?{lastPreparationFailure:old.lastPreparationFailure}:{}),deviceId:d.deviceId,deviceNumber:n,enabled:d.enabled===true};});
        }
        if(input.grants!==undefined){
          if(!Array.isArray(input.grants)||input.grants.length>100)throw managedLookupError('invalid_pool_grants');const seen=new Set();
          s.grants=input.grants.map(g=>{if(seen.has(g.clientId)||!adapter.clientValid(g.clientId)||!/^[A-Za-z0-9._:-]{8,160}$/.test(g.consentReference||''))throw managedLookupError('invalid_pool_grants');seen.add(g.clientId);return {clientId:g.clientId,enabled:g.enabled===true,consentReference:g.consentReference};});
        }
        if(input.resetUnavailableDeviceIds!==undefined){
          const ids=input.resetUnavailableDeviceIds;
          if(input.expectedConfigRevision===undefined||!Array.isArray(ids)||!ids.length||ids.length>49||new Set(ids).size!==ids.length)throw managedLookupError('invalid_unavailable_reset');
          for(const id of ids){
            const d=s.devices.find(d=>d.deviceId===id);
            if(!d||!lookupDeviceUnavailable(d))throw managedLookupError('lookup_device_not_quarantined',409);
            if(s.channels.some(c=>c.deviceId===id)||!adapter.health(id).ready)throw managedLookupError('lookup_device_reset_not_ready',409);
            resetLookupUnavailable(d);for(const p of s.preparations||[])p.probeAttempts=p.probeAttempts.filter(a=>a.deviceId!==id);audit(s,'lookup_device_reprobe',actor,{deviceId:id});
          }
        }
        s.configRevision=(s.configRevision||0)+1;audit(s,'pool_configuration',actor,{configRevision:s.configRevision});return {configRevision:s.configRevision};
      });
    },
    preview(){return LOOKUP_POOL_NUMBERS.map(n=>adapter.resolveNumber(n));},
    adminRequest:id=>store.adminRequest(id),
    adminRequests:cursor=>store.adminRequests(cursor),
    adminReady:c=>readiness.valid(store.snapshot(),c),
    admin(){const s=store.snapshot();return {...s,clientOptions:adapter.clientOptions?.()||[],requests:s.requests.map(({phoneNumber,fingerprint,idempotencyKey,...r})=>({...r,hasName:Boolean(r.name)})),devices:s.devices.map(d=>({...d,health:d.accountOffline?{ready:false,reason:'account_login_required',account:d.accountOffline.account,accountSource:d.accountOffline.accountSource,scope:'prepare_round'}:lookupDeviceUnavailable(d)?{ready:false,reason:'lookup_device_unavailable',failures:d.prepareFailureCount}:s.preparations?.some(p=>preparationBlocked(s,d,p.clientId))?{ready:false,reason:'preparation_failed_round',code:d.preparationIssue?.code,scope:'prepare_round'}:d.quarantineUntil>now()?{ready:false,reason:'preparation_backoff',until:d.quarantineUntil}:adapter.health(d.deviceId),channel:s.channels.find(c=>c.deviceId===d.deviceId)||null})),counts:{registered:s.devices.length,executing:activeCount(s),waitingHuman:s.channels.filter(c=>c.phase==='human').length,queued:s.requests.filter(r=>r.status==='queued').length}};},
    async submit({clientId,phoneNumber,key}){
      if(!key||!/^[A-Za-z0-9._:-]{8,160}$/.test(key))throw managedLookupError('idempotency_key_required');
      return store.transact(async (s,tx)=>{
        const grant=authorized(s,clientId);if(!grant||!adapter.clientValid(clientId))throw managedLookupError('managed_lookup_not_authorized',403);
        const fingerprint=crypto.createHash('sha256').update(phoneNumber).digest('hex');
        const old=await managedRequestByKey(s,tx,clientId,key);
        if(old){if(old.fingerprint!==fingerprint)throw managedLookupError('idempotency_conflict',409);return old.lookupId;}
        if(roundStopRequested(s,clientId))throw managedLookupError('lookup_round_stopped',409);
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
    async recordHumanObservation(target, observation){
      const result=await store.transact(s=>{
        const c=s.channels.find(c=>c.sessionId===target.sessionId&&c.deviceId===target.deviceId);
        const r=c&&s.requests.find(r=>r.lookupId===c.requestId);
        if(!c||!r||DONE.has(r.status)||r.cancelRequested||c.roundStopPreparationId||c.offlineHandoffAt!==undefined||c.phase!=='human')return false;
        const previous=c.humanObservation;
        const same = previous?.owner===observationOwner&&previous.state===observation.state&&previous.target.challengeId===target.challengeId&&previous.target.screenSessionId===target.screenSessionId&&now()-previous.at>=0&&now()-previous.at<=30000;
        c.humanObservation={stateSince:same?previous.stateSince??previous.at:now(),owner:observationOwner,state:observation.state,confirmed:['search_ready','account_limited','login_required','recoverable_page'].includes(observation.state)&&observation.confirmed===true,at:now(),reason:observation.reason,readDurationMs:observation.readDurationMs,
          confirmedAt:observation.confirmed?(previous?.confirmed&&previous.target.challengeId===target.challengeId&&previous.target.screenSessionId===target.screenSessionId?previous.confirmedAt:now()):null,
          target:{sessionId:target.sessionId,deviceId:target.deviceId,challengeId:target.challengeId,screenSessionId:target.screenSessionId}};
        return true;
      });syncOccupied();return result;
    },
    async beforeResume(sessionId){
      return store.transact(s=>{const c=s.channels.find(c=>c.sessionId===sessionId);if(!c||c.roundStopPreparationId||c.offlineHandoffAt!==undefined||!humanActionable(c))return false;const r=s.requests.find(r=>r.lookupId===c.requestId);if(!s.config.enabled||!r||DONE.has(r.status)||r.cancelRequested||!authorized(s,c.clientId)||!adapter.clientValid(c.clientId)||!adapter.health(c.deviceId,{allowScreenControl:true}).ready||activeCount(s)>=s.config.concurrency)return false;c.phase='resuming';delete c.humanObservation;return true;}).then(result=>{syncOccupied();return result;});
    },
    aiCandidates(){
      const s=store.snapshot();
      return s.channels.flatMap(c=>{const binding=aiCandidate(s,c.requestId),r=s.requests.find(r=>r.lookupId===c.requestId);
        return binding&&(!r.aiVision||r.aiVision.jobId!==binding.jobId||r.aiVision.status==='reading'&&now()>=r.aiVision.leaseUntil)?[{...binding,expired:r.aiVision?.jobId===binding.jobId&&r.aiVision.status==='reading'}]:[];});
    },
    async claimAiReading(binding){
      return store.transact(s=>{
        const candidate=aiCandidate(s,binding.lookupId),r=s.requests.find(x=>x.lookupId===binding.lookupId),c=s.channels.find(x=>x.requestId===binding.lookupId);
        if(!sameAiBinding(candidate,binding)||r.aiVision?.jobId===binding.jobId&&!(r.aiVision.status==='reading'&&now()>=r.aiVision.leaseUntil&&binding.expired))return false;
        r.aiVision={status:'reading',jobId:binding.jobId,evidenceId:binding.evidenceId,startedAt:at(),leaseUntil:now()+130000,token:binding.token};
        c.aiVision={...r.aiVision};audit(s,'lookup_ai_reading_started','system',{lookupId:r.lookupId,deviceId:c.deviceId,jobId:binding.jobId,evidenceId:binding.evidenceId});return true;
      }).then(result=>{syncOccupied();return result;});
    },
    async finishAiReading(binding,result={}){
      return store.transact(async(s,tx)=>{
        const candidate=aiCandidate(s,binding.lookupId),r=s.requests.find(x=>x.lookupId===binding.lookupId),c=s.channels.find(x=>x.requestId===binding.lookupId);
        if(!sameAiBinding(candidate,binding)||r.aiVision?.jobId!==binding.jobId||r.aiVision.status!=='reading'||r.aiVision.token!==binding.token)return false;
        // Internal diagnostics never expand the public name-or-empty contract.
        const named=result.kind==='name'&&result.evidenceSha256===binding.evidenceSha256&&result.matchedPhone===r.phoneNumber&&typeof result.name==='string'&&result.name.length<=128&&!/[\x00-\x1f\x7f]/.test(result.name)&&/[（(]\*+(?:·\*+)*[\u3400-\u9fff][）)]$/u.test(result.name);
        r.name=named?result.name:'';finish(r,named?'succeeded':'not_found');
        r.aiVision={...r.aiVision,status:'completed',completedAt:at(),model:'gpt-6.1-sol',evidenceSha256:binding.evidenceSha256,reason:named?'name':result.reason||'empty',elapsedMs:result.elapsedMs};
        await adapter.recordAiResult(c,r,tx,binding);
        // Restore only this process's existing, previously probed account proof.
        // A new identity, restart or uncertain answer cannot earn readiness.
        const clearResult=(named||['no_name','unverified'].includes(result.kind))&&result.evidenceSha256===binding.evidenceSha256&&result.matchedPhone===r.phoneNumber;
        if(clearResult&&c.aiReadinessProof)c.readinessProof={...c.aiReadinessProof,lastSuccessAt:now()};
        const reusable=clearResult&&readiness.valid(s,c);delete c.aiReadinessProof;
        if(reusable){c.aiVision={...r.aiVision,cleanup:false};delete c.pageCompatibilityRequired;}
        else{r.cancelRequested=true;r.cancelReason='lookup_ai_result_cleanup';c.aiVision={...r.aiVision,cleanup:true};delete c.readinessProof;delete c.readinessPriorityAt;}

        audit(s,'lookup_ai_result_recorded','system',{lookupId:r.lookupId,deviceId:c.deviceId,jobId:binding.jobId,evidenceId:binding.evidenceId,evidenceSha256:binding.evidenceSha256,hasName:named});return true;
      }).then(result=>{syncOccupied();return result;});
    },
    async retry(lookupId,actor){
      await store.transact(async(s,tx)=>{
        const r=s.requests.find(r=>r.lookupId===lookupId),c=s.channels.find(c=>c.requestId===lookupId);
        if(!r||!c||r.cancelRequested||c.roundStopPreparationId||c.phase!=='recovery'||r.status!=='needs_recovery')throw managedLookupError('managed_recovery_not_ready',409);
        if(!authorized(s,r.clientId)||!adapter.clientValid(r.clientId))throw managedLookupError('managed_lookup_not_authorized',403);
        if(activeCount(s)>=s.config.concurrency)throw managedLookupError('managed_lookup_capacity_busy',409);
        if(!adapter.health(c.deviceId).ready)throw managedLookupError('managed_lookup_device_not_ready',409);
        await adapter.query(c,r,tx,{recovery:true,prepared:r.resultProtocol===PREPARED_PROTOCOL,probePhone:readiness.probePhone,verified:false});c.phase=r.queryId?'querying':'starting';r.status='retrying';r.code='';audit(s,'lookup_retry_original',actor,{lookupId});
      });syncOccupied();
    },
    async cancel(lookupId,actor){
      await store.transact(async(s,tx)=>{const r=s.requests.find(r=>r.lookupId===lookupId);if(!r)throw managedLookupError('lookup_not_found',404);if(DONE.has(r.status))return;if(r.status==='queued')finish(r,'cancelled','lookup_cancelled');else{r.cancelRequested=true;r.status='cancelling';}audit(s,'lookup_cancel',actor,{lookupId});});syncOccupied();
    },
    tick(){
      if(tickPromise)return tickPromise;
      tickPromise=(async()=>{
        if(store.isFenced?.())throw new Error('managed_lookup_storage_fenced');
        await reconcileRoundIdle();
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
        if(store.snapshot().roundStops?.some(r=>r.status==='stopping'))await store.transact(s=>settleRoundStops(s,now));
        const snapshot=store.snapshot();
        if(snapshot.requests.some(r=>r.status==='queued'&&queuedExpired(snapshot,r)))await store.transact(expireQueued);
        await reconcileRoundIdle();
        if(resumeHuman){
          const ready=store.snapshot().channels.filter(c=>c.phase==='human'&&humanActionable(c)).sort((a,b)=>a.humanObservation.confirmedAt-b.humanObservation.confirmedAt);
          for(const c of ready){
            if(activeCount(store.snapshot())>=store.snapshot().config.concurrency)break;
            try{await resumeHuman(c.humanObservation.target);}catch(error){errors.push(error);failedDevices.add(c.deviceId);}
          }
        }
        // Retire only excess proven idle sessions. Stop consumes an execution
        // slot and the reservation remains until the normal stop ACK path.
        // Recompute inside every transaction: another result/admission may have
        // changed which five phones to keep since the previous snapshot.
        for(const original of readiness.surplus(store.snapshot())){
          if(failedDevices.has(original.deviceId)||activeCount(store.snapshot())>=store.snapshot().config.concurrency)continue;
          await deviceTransaction(original.deviceId,async(s,tx)=>{
            const c=readiness.surplus(s).find(c=>c.deviceId===original.deviceId&&c.generation===original.generation&&c.sessionId===original.sessionId);
            if(!c||activeCount(s)>=s.config.concurrency||!adapter.canStop(c))return;
            await adapter.stop(c,tx);c.phase='stopping';delete c.readinessProof;delete c.readinessPriorityAt;
            audit(s,'lookup_surplus_idle_stop','system',{deviceId:c.deviceId,sessionId:c.sessionId,preparationId:c.preparationId});
          });
        }
        // Each admission is also its own transaction, with a fresh capacity
        // check. A bad device is excluded for this tick, never tried forever.
        const budget=store.snapshot().devices.length+5;
        for(let attempt=0;attempt<budget&&admissionAllowed(store.snapshot());attempt++){
          let selectedDevice;
          const outcome=await deviceTransaction(()=>selectedDevice,async(s,tx)=>{
            expireQueued(s);if(!admissionAllowed(s))return false;
            const retiring=new Set(readiness.surplus(s).map(c=>c.deviceId));
            const waiting=s.requests.filter(r=>r.status==='queued'),clients=[...new Set(waiting.map(r=>r.clientId))],last=clients.indexOf(s.lastClient);
            const order=last<0?clients:[...clients.slice(last+1),...clients.slice(0,last+1)];
            let selected;
            clientSelection: for(const clientId of order){
              // FIFO among dispatchable requests. A reroute excluded from all
              // current proofs must not idle phones that can serve later work.
              for(const r of waiting.filter(r=>r.clientId===clientId&&r.purpose!=='readiness_probe')){
              if(r.waitForLookupId&&s.channels.some(c=>c.requestId===r.waitForLookupId))continue;
              const used=new Set(r.attempts.map(a=>a.deviceId)),candidates=[];
              for(const d of s.devices){
                if(retiring.has(d.deviceId)||(r.recoveryExcludedDevices?.includes(d.deviceId)||r.humanWaitExcludedDevices?.includes(d.deviceId))||!d.enabled||lookupDeviceUnavailable(d)||d.accountOffline||releasedDevices.has(d.deviceId)||failedDevices.has(d.deviceId)||d.quarantineUntil>now()||(r.resultProtocol!==PREPARED_PROTOCOL&&used.has(d.deviceId)))continue;
                const c=s.channels.find(c=>c.deviceId===d.deviceId);if(c&&!(c.phase==='idle'&&c.clientId===clientId))continue;
                // One physical reservation budget includes human and idle channels.
                // Existing healthy channels continue even during legacy surplus cleanup.
                const humans=s.channels.filter(x=>x.phase==='human').length;
                if(!c&&(occupiedCount(s)>=s.config.concurrency||(r.resultProtocol!==PREPARED_PROTOCOL&&humans>0&&humans>=s.config.humanLimit)))continue;
                if(r.resultProtocol===PREPARED_PROTOCOL&&(!c||!readiness.valid(s,c)||r.attempts.some(a=>a.deviceId===d.deviceId&&a.readinessIdentity===c.readinessProof?.identity)))continue;
                try{if(adapter.health(d.deviceId).ready)candidates.push({d,c});}catch(error){failedDevices.add(d.deviceId);errors.push(error);}
              }
              const priority=x=>r.resultProtocol===PREPARED_PROTOCOL&&Number.isFinite(x.c?.readinessPriorityAt);
              candidates.sort((a,b)=>Number(priority(b))-Number(priority(a))||(priority(a)&&priority(b)?a.c.readinessPriorityAt-b.c.readinessPriorityAt:0)||Number(!a.c)-Number(!b.c)||(a.d.lastBusinessSequence||0)-(b.d.lastBusinessSequence||0)||(a.d.lastUsedAt||0)-(b.d.lastUsedAt||0));
              if(candidates.length){selected={r,...candidates[0]};break clientSelection;}
              }
            }
            if(!selected)return false;
            const {r,d}=selected;let c=selected.c;selectedDevice=d.deviceId;
            if(!c){c={deviceId:d.deviceId,deviceNumber:d.deviceNumber,clientId:r.clientId,generation:crypto.randomUUID(),requestId:r.lookupId,phase:'starting'};s.channels.push(c);await adapter.start(c,r,tx);r.status='preparing';}
            else{c.requestId=r.lookupId;await adapter.query(c,r,tx,{prepared:r.resultProtocol===PREPARED_PROTOCOL,probePhone:readiness.probePhone,verified:readiness.valid(s,c)});delete c.readinessPriorityAt;c.phase='querying';r.status='running';}
            r.attempts.push({deviceId:d.deviceId,generation:c.generation,sessionId:c.sessionId,readinessIdentity:c.readinessProof?.identity,at:at()});d.lastUsedAt=now();d.lastBusinessSequence=s.businessSequence=(s.businessSequence||0)+1;s.lastClient=r.clientId;return true;
          });
          if(outcome.ok&&!outcome.result)break;
        }
        // Preparation uses the same serialized transactions and five execution slots.
        // Business admissions above always take precedence over background probes.
        for(let n=0;n<5;n++){
          const snap=store.snapshot();if(activeCount(snap)>=snap.config.concurrency)break;
          const pick=readiness.next(snap,new Set([...failedDevices,...releasedDevices]));if(!pick)break;
          await deviceTransaction(pick.d.deviceId,async(s,tx)=>{
            if(activeCount(s)>=s.config.concurrency)return;
            const chosen=readiness.next(s,new Set([...failedDevices,...releasedDevices]));if(!chosen||chosen.d.deviceId!==pick.d.deviceId)return;
            let {c,d,p}=chosen;if(!c&&occupiedCount(s)>=s.config.concurrency)return;
            if(!c){c={deviceId:d.deviceId,deviceNumber:d.deviceNumber,clientId:p.clientId,generation:crypto.randomUUID(),phase:'starting'};s.channels.push(c);const r=readiness.newProbe(s,c,p);await adapter.start(c,r,tx);r.status='preparing';r.attempts.push({deviceId:d.deviceId,generation:c.generation,sessionId:c.sessionId,at:at()});}
            else{const r=readiness.newProbe(s,c,p);await adapter.query(c,r,tx);c.phase='querying';r.status='running';r.attempts.push({deviceId:d.deviceId,generation:c.generation,sessionId:c.sessionId,at:at()});}
            d.lastUsedAt=now();delete d.accountRepairAt;
          });
        }
        if(errors.length)throw new AggregateError(errors,'managed_lookup_device_errors');
      })().finally(()=>{tickPromise=null;});return tickPromise;
    },
    async close(){closed=true;await tickPromise?.catch(()=>{});await store.close();}
  };
}
