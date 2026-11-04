import {PREINPUT_RECOVERY,originalRecoveryContext,recoveryProposal,canRetryRecovery,recoveryRequest,validateRecoveryProof,exact as recoveryExact,recoveryFail} from './wecom-preinput-recovery.mjs';
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {createWecomCausalClock,WECOM_CAUSAL_PROTOCOL} from "./wecom-causal-clock.mjs";
import {previewOperationFingerprint,previewRemarkInput,previewJobRemarks} from "./wecom-preview.mjs";
import { WECOM_CLEANUP_KIND, WECOM_CLEANUP_LOCK, isWecomCleanupPending,
  pendingWecomCleanup, createWecomCleanupObligation, assertCleanupBinding, recordWecomHosts, recordWecomHostClosed,
  noteWecomTerminal, createWecomVerification, wecomVerificationLease,
  validateWecomProof, completeWecomVerification } from "./wecom-physical-cleanup.mjs";

const terminal = status => ["succeeded", "failed", "cancelled", "expired"].includes(status);
const fail = code => { throw Object.assign(new Error(`wecom_cleanup_${code}`), { statusCode: 409 }); };
const iso = time => new Date(time).toISOString();
const serialKey = value => String(value || "").trim().toLowerCase();
const exact = (body, keys) => body && typeof body === "object" && !Array.isArray(body)
  && Object.keys(body).length === keys.length && keys.every(k => Object.hasOwn(body, k));

// The injected persistence policy owns either the existing JSON checkpoint or
// the existing PostgreSQL transaction. No new database table is introduced.
export function createWecomCleanupService({ state, persist, conflict = () => false, now = Date.now, id = randomUUID, clock = createWecomCausalClock() }) {
  const queues = new Map(), committing = new Map(), checkpointFences = new Map();
  function businessScope(task,job,lock) {
    if(!task||!job||!lock||task.type!=="wecom_customer_preview"||job.kind!==task.type
      ||task.payload?.automationJobId!==job.jobId||job.windowsTaskId!==task.taskId||job.lockId!==lock.lockId
      ||lock.taskId!==job.jobId||lock.lockType!==job.kind||lock.ownerUserId!==job.userId
      ||[job.deviceId,lock.deviceId].some(v=>v!==task.deviceId)||job.agentId!==task.agentId||job.adbSerial!==task.adbSerial
      ||task.payload.phoneNumber!==job.phoneNumber||!isDeepStrictEqual(previewRemarkInput(task.payload),previewJobRemarks(job))
      ||(task.payload.mode||"preview")!==(job.wecomMode||"preview")||task.payload.androidUser!==job.wecomAndroidUser
      ||task.payload.appSlot!==job.wecomAppSlot)fail("causal_context_unconfirmed");
    return {taskId:task.taskId,jobId:job.jobId,lockId:lock.lockId,deviceId:task.deviceId,serial:task.adbSerial,agentId:task.agentId,
      appSlot:job.wecomAppSlot,androidUser:job.wecomAndroidUser,operationFingerprint:previewOperationFingerprint(job)};
  }
  const contextFor=task=>{const job=state.automationJobs.find(j=>j.jobId===task?.payload?.automationJobId);return {job,lock:state.deviceLocks.find(l=>l.lockId===job?.lockId)};};
  function bindBusinessLease(stamp,task,job,lock){
    if(task?.status!=="queued"||job?.status!=="queued"||lock?.status!=="active"||Object.hasOwn(task.payload,"wecomCausalLease")||Object.hasOwn(job,"wecomCausalLease"))fail("causal_context_unconfirmed");
    const ticket=clock.businessLease(stamp,businessScope(task,job,lock));task.payload.wecomCausalLease=structuredClone(ticket);job.wecomCausalLease=structuredClone(ticket);return ticket;
  }
  function businessLeaseState(task){try{const {job,lock}=contextFor(task);if(!isDeepStrictEqual(task.payload.wecomCausalLease,job.wecomCausalLease))return {known:false,remainingMs:0};return {known:true,remainingMs:clock.remaining(task.payload.wecomCausalLease,businessScope(task,job,lock))};}catch{return {known:false,remainingMs:0};}}
  function businessRemaining(task){return businessLeaseState(task).remainingMs;}
  function businessLockState(lock){
    if(lock?.lockType!=="wecom_customer_preview")return null;
    const job=state.automationJobs.find(j=>j.jobId===lock.taskId&&j.lockId===lock.lockId),task=state.windowsTasks.find(t=>t.taskId===job?.windowsTaskId);
    return job?.wecomCausalLease||task?.payload?.wecomCausalLease?businessLeaseState(task):null;
  }
  function createObligation(task,job,device){
    if(task?.status!=="running"||businessRemaining(task)<=3000)fail("causal_context_unconfirmed");
    const lock=createWecomCleanupObligation(task,job,device,{now:now(),id});
    lock.physicalCleanup.causal={protocol:WECOM_CAUSAL_PROTOCOL,serverEpoch:clock.epoch,businessLease:structuredClone(task.payload.wecomCausalLease)};return lock;
  }
  const verificationScope=lock=>{const v=lock.physicalCleanup.verification;return {binding:lock.physicalCleanup.binding,verificationId:v.verificationId,verificationNonce:v.verificationNonce,verificationTaskId:v.verificationTaskId};};
  function verificationLeaseState(lock){try{if(lock.physicalCleanup.causal.serverEpoch!==clock.epoch)return {known:false,remainingMs:0};return {known:true,remainingMs:clock.remaining(lock.physicalCleanup.verification.causalLease,verificationScope(lock))};}catch{return {known:false,remainingMs:0};}}
  function verificationRemaining(lock){return verificationLeaseState(lock).remainingMs;}
  function causal(lock){if(lock.physicalCleanup?.causal?.protocol!==WECOM_CAUSAL_PROTOCOL||lock.physicalCleanup.causal.serverEpoch!==clock.epoch)fail("causal_context_unconfirmed");}
  function pending(deviceId) {
    return committing.get(deviceId) || pendingWecomCleanup(state.deviceLocks, deviceId);
  }
  async function serialize(deviceId, fn) {
    const prior = queues.get(deviceId) || Promise.resolve();
    let resolve; const tail = new Promise(r => { resolve = r; });
    queues.set(deviceId, tail);
    try { await prior; return await fn(); }
    finally { resolve(); if (queues.get(deviceId) === tail) queues.delete(deviceId); }
  }
  async function transaction(lock, fn) {
    const lockBefore = structuredClone(lock);
    const tasksBefore = new Map(), locksBefore = new Map(); const created = [];
    const trackLock = other => { if (other && !locksBefore.has(other)) locksBefore.set(other, structuredClone(other)); return other; };
    const track = task => { if (task && !tasksBefore.has(task)) tasksBefore.set(task, structuredClone(task)); return task; };
    const add = task => { state.windowsTasks.unshift(task); created.push(task); return task; };
    // Keep a pending fence throughout the write, even after the in-memory
    // release candidate is formed. A failed write must never open the phone.
    committing.set(lock.deviceId, lockBefore);
    let writing = false;
    try {
      const result = fn({ track, trackLock, add });
      checkpointFences.set(lock.deviceId, { locks: new Map([[lock, lockBefore], ...locksBefore]), tasks: tasksBefore, created });
      writing = true;
      await persist(structuredClone({ deviceLock: lock, deviceLocks: [...locksBefore.keys()], windowsTasks: [...tasksBefore.keys(), ...created] }));
      return result;
    } catch (error) {
      for (const key of Object.keys(lock)) delete lock[key]; Object.assign(lock, lockBefore);
      for (const [task, before] of [...tasksBefore, ...locksBefore]) {
        for (const key of Object.keys(task)) delete task[key]; Object.assign(task, before);
      }
      for (const task of created) { const at = state.windowsTasks.indexOf(task); if (at >= 0) state.windowsTasks.splice(at, 1); }
      if (writing) throw Object.assign(new Error("wecom_cleanup_storage_unavailable"), { statusCode: 503 });
      throw error;
    } finally { committing.delete(lock.deviceId); checkpointFences.delete(lock.deviceId); }
  }
  // A concurrent checkpoint must not serialize an uncommitted release. The
  // JSON transaction explicitly overlays its own candidate; unrelated writers
  // see the last committed rows. Other phones/records keep their current data.
  function checkpoint(snapshot, ownBundle = null) {
    const locks = new Map(snapshot.deviceLocks.map(l => [l.lockId, l]));
    const tasks = new Map(snapshot.windowsTasks.map(t => [t.taskId, t]));
    for (const fence of checkpointFences.values()) {
      for (const [row, before] of fence.locks) locks.set(row.lockId, before);
      for (const [row, before] of fence.tasks) tasks.set(row.taskId, before);
      for (const row of fence.created) tasks.delete(row.taskId);
    }
    if (ownBundle) {
      for (const row of [ownBundle.deviceLock, ...(ownBundle.deviceLocks || [])].filter(Boolean)) locks.set(row.lockId, row);
      for (const row of ownBundle.windowsTasks || []) tasks.set(row.taskId, row);
    }
    return { ...snapshot, deviceLocks: [...locks.values()], windowsTasks: [...tasks.values()] };
  }
  function checkpointWriting(lock) { return checkpointFences.has(lock.deviceId); }
  function locate(agentId, obligationId) {
    const lock = state.deviceLocks.find(l => l.lockId === obligationId && l.lockType === WECOM_CLEANUP_LOCK);
    if (!lock || lock.physicalCleanup?.binding?.agentId !== agentId) fail("binding_mismatch");
    return lock;
  }
  function execution(lock) {
    const duty = lock.physicalCleanup;
    return { task: state.windowsTasks.find(t => t.taskId === duty.binding?.originalTaskId),
      job: state.automationJobs.find(j => j.jobId === duty.originalJobId) };
  }
  function retireKnownProof(lock) {
    const duty=lock.physicalCleanup,v=duty?.verification;
    if(lock.status!=="released"||!duty.proof||!v
      ||state.deviceLocks.some(l=>isWecomCleanupPending(l)&&(l.deviceId===lock.deviceId
        ||serialKey(l.physicalCleanup?.binding?.serial||l.physicalCleanup?.legacySerial||state.devices.find(d=>d.deviceId===l.deviceId)?.adb?.serial)===serialKey(duty.binding.serial))))return;
    const {task,job}=execution(lock),verify=verificationTask(lock);
    if(!terminal(task?.status)&&!terminal(job?.status)||verify?.status!=="succeeded")return;
    // Failure to reconstruct an archived/drifted original scope retains its
    // bounded slot; never guess a replacement scope just to reclaim capacity.
    try{clock.retire(v.causalLease,verificationScope(lock));}catch{}
    try{
      const original=state.deviceLocks.find(l=>l.lockId===duty.originalLockId);
      if(!isDeepStrictEqual(duty.causal.businessLease,task.payload.wecomCausalLease)
          ||!isDeepStrictEqual(task.payload.wecomCausalLease,job.wecomCausalLease))return;
      clock.retire(duty.causal.businessLease,businessScope(task,job,original));
    }catch{}
  }
  function verificationTask(lock) {
    return state.windowsTasks.find(t => t.taskId === lock.physicalCleanup?.verification?.verificationTaskId);
  }
  function deviceMatches(lock) {
    const binding = lock.physicalCleanup?.binding;
    const device = state.devices.find(d => d.deviceId === lock.deviceId);
    return Boolean(binding && device?.adb?.serial === binding.serial && device.adb.agentId === binding.agentId);
  }
  function originalReady(task) {
    if (!task?.payload?.physicalCleanup || businessRemaining(task)<=3000) return false;
    const lock = pending(task.deviceId);
    return Boolean(lock && !committing.has(lock.deviceId) && deviceMatches(lock)
      && isDeepStrictEqual(lock.physicalCleanup.binding, task.payload.physicalCleanup)
      && lock.physicalCleanup.causal?.serverEpoch===clock.epoch && lock.physicalCleanup.causal?.bootstrap
      && lock.physicalCleanup.hosts && !lock.physicalCleanup.hostClosedAt
      && !lock.physicalCleanup.originalTerminalAt && task.status === "running");
  }
  function canPick(task) {
    if(task?.payload?.preinputRecovery)return recoveryCanPick(task);
    if(["wecom_customer_preview",WECOM_CLEANUP_KIND].includes(task.type)&&task.status!=="queued")return false;
    const lock = pending(task.deviceId) || [...committing.values(), ...(state.deviceLocks || [])].find(l => isWecomCleanupPending(l)
      && serialKey(l.physicalCleanup?.binding?.serial || l.physicalCleanup?.legacySerial || state.devices.find(d => d.deviceId === l.deviceId)?.adb?.serial) === serialKey(task.adbSerial) && serialKey(task.adbSerial));
    if (!lock) return task.type === "wecom_customer_preview" ? businessRemaining(task)>3000 : task.type !== WECOM_CLEANUP_KIND;
    if (committing.has(lock.deviceId) || task.type !== WECOM_CLEANUP_KIND) return false;
    const v = lock.physicalCleanup?.verification;
    return Boolean(v && v.verificationTaskId === task.taskId && task.status === "queued"
      && verificationRemaining(lock)>0 && deviceMatches(lock)
      && isDeepStrictEqual(task.payload?.physicalCleanup, lock.physicalCleanup.binding)
      && !conflict(lock, task));
  }
  function picked(task) {
    if (task.type !== WECOM_CLEANUP_KIND) return null;
    const lock = pendingWecomCleanup(state.deviceLocks, task.deviceId);
    const verification=task.payload?.preinputRecovery?lock?.physicalCleanup?.recovery:lock?.physicalCleanup?.verification;
    if (!lock || verification?.verificationTaskId !== task.taskId) fail("binding_mismatch");
    verification.pickedAt = task.pickedAt;
    lock.updatedAt = iso(now()); return lock;
  }
  function noteTerminal(task, job) {
    const lock = pendingWecomCleanup(state.deviceLocks, task?.deviceId || job?.deviceId);
    if (!lock) return null;
    noteWecomTerminal(lock, task, job, now());
    return lock;
  }
  // A pre-protocol task can become terminal during rollout. It gets a durable
  // maintenance hold, never invented PID/runtime/nonce evidence.
  function ensureLegacy(task, job) {
    if (task?.type !== "wecom_customer_preview" || !task.pickedAt || !task.deviceId) return null;
    const found = (state.deviceLocks || []).find(l => l.lockType === WECOM_CLEANUP_LOCK
      && (l.physicalCleanup?.binding?.originalTaskId || l.physicalCleanup?.legacyTaskId) === task.taskId);
    if (found) return found;
    const at = iso(now()), lockId = id();
    const lock = { lockId, taskId: lockId, deviceId: task.deviceId, lockType: WECOM_CLEANUP_LOCK,
      status: "cleanup_pending", expiresAt: "", createdAt: at, updatedAt: at, ownerUserId: job?.userId || "",
      physicalCleanup: { phase: "maintenance", legacyTaskId: task.taskId, legacySerial: task.adbSerial || "", originalJobId: job?.jobId || task.payload?.automationJobId || "",
        reason: "legacy_host_identity_missing" } };
    state.deviceLocks.unshift(lock); return lock;
  }
  async function handle(agentId, obligationId, action, body) {
    const lock = locate(agentId, obligationId);
    return serialize(lock.deviceId, async () => {
      assertCleanupBinding(lock, body?.binding, agentId);
      if (!deviceMatches(lock)) fail("binding_mismatch");
      if (action === "proof" && lock.status === "released") {
        if (!isDeepStrictEqual(body, lock.physicalCleanup.proof)) fail("proof_invalid");
        return { ok: true, verified: true, reused: true };
      }
      causal(lock);
      if (!isWecomCleanupPending(lock)) fail("binding_mismatch");
      const result=await transaction(lock, ({ track, trackLock, add }) => {
        const { task, job } = execution(lock);
        noteWecomTerminal(lock, task, job, now());
        if (action === "host") { if(businessRemaining(task)<=3000)fail("causal_context_unconfirmed");recordWecomHosts(lock, body, task, now()); return { ok: true }; }
        if (action === "host-closed") { recordWecomHostClosed(lock, body, now()); return { ok: true }; }
        if (action === "verify") {
          if (!exact(body, ["binding"])) fail("binding_mismatch");
          if (!lock.physicalCleanup.originalTerminalAt) fail("not_terminal");
          if (!lock.physicalCleanup.hostClosedAt) fail("host_unconfirmed");
          const existing = verificationTask(lock);
          if (existing && !terminal(existing.status) && verificationRemaining(lock)>0) {
            return { ok: true, reused: true, taskId: existing.taskId };
          }
          if (conflict(lock, existing)) fail("device_busy");
          if (existing && !terminal(existing.status)) {
            track(existing); existing.status = "expired"; existing.updatedAt = existing.completedAt = iso(now());
          }
          // Do not auto-renew an expired/failed verification's authority.
          if(existing)fail("causal_context_unconfirmed");
          const stamp=clock.mark("verification");
          try{
            const verification=add(createWecomVerification(lock,{now:now(),id}));
            const ticket=clock.verificationLease(stamp,verificationScope(lock));
            lock.physicalCleanup.verification.causalLease=structuredClone(ticket);verification.payload.causalLease=structuredClone(ticket);
            return {ok:true,taskId:verification.taskId,reused:false};
          }finally{clock.releaseMark(stamp);}
        }
        if(action==="challenge"){
          const verification=verificationTask(lock);
          if(!exact(body,["binding","verificationId","verificationNonce","verificationTaskId"])||conflict(lock,verification)
            ||!wecomVerificationLease(lock,verification,body,agentId,now(),verificationRemaining(lock)))fail("proof_invalid");
          const challenge=clock.challenge(lock.physicalCleanup.verification.causalLease,verificationScope(lock));
          const previous=lock.physicalCleanup.verification.challenge;
          if(previous&&!isDeepStrictEqual(previous,challenge))fail("proof_invalid");
          lock.physicalCleanup.verification.challenge=structuredClone(challenge);return {ok:true,challenge};
        }
        if (action === "proof") {
          const verification = verificationTask(lock);
          if (conflict(lock, verification)) fail("device_busy");
          const proof = validateWecomProof(lock, verification, body, agentId, now(),verificationRemaining(lock));
          const originalLock = state.deviceLocks.find(l => l.lockId === lock.physicalCleanup.originalLockId);
          if(originalLock?.status==="active"&&(originalLock.deviceId!==lock.deviceId||originalLock.taskId!==lock.physicalCleanup.originalJobId||originalLock.lockType!=="wecom_customer_preview"))fail("original_lock_mismatch");
          // Last synchronous authority check, inside the per-device queue,
          // after full proof validation and before ANY released candidate.
          clock.validateChallenge(body.challenge,lock.physicalCleanup.verification.causalLease,verificationScope(lock));
          if (originalLock?.status === "active") {
            if (originalLock.deviceId !== lock.deviceId || originalLock.taskId !== lock.physicalCleanup.originalJobId
                || originalLock.lockType !== "wecom_customer_preview") fail("original_lock_mismatch");
            trackLock(originalLock); originalLock.status = "released";
            originalLock.releasedAt = originalLock.updatedAt = iso(now());
            originalLock.releaseReason = "wecom_physical_verified";
          }
          track(verification); completeWecomVerification(lock, verification, proof, now());
          return { ok: true, verified: true, reused: false };
        }
        fail("invalid_action");
      });
      // Only this known durable proof completion may retire authority. Failed
      // or unknown persistence never reaches here; exact lost ACK replay is
      // answered above from the original saved proof, without live tickets.
      if(action==="proof"&&result.verified===true)retireKnownProof(lock);
      return result;
    });
  }
  // Recover one missed request after restart/outbox delay. Never loop failed
  // verification generations or replay the original business task.
  async function reconcile(agentId) {
    const lock = state.deviceLocks.find(l => isWecomCleanupPending(l)
      && l.physicalCleanup?.causal?.serverEpoch===clock.epoch && l.physicalCleanup?.binding?.agentId === agentId && l.physicalCleanup.hostClosedAt
      && !l.physicalCleanup.verification && deviceMatches(l) && !conflict(l, null)
      && (l.physicalCleanup.originalTerminalAt || terminal(execution(l).task?.status) || terminal(execution(l).job?.status)));
    if (!lock) return null;
    return handle(agentId, lock.lockId, "verify", { binding: structuredClone(lock.physicalCleanup.binding) });
  }
  async function status(task, input) {
    if(task?.payload?.preinputRecovery)return recoveryStatus(task,input);
    if (input.status === "succeeded") fail("proof_required");
    if (!["running", "failed", "cancelled"].includes(input.status)) fail("invalid_status");
    const lock = locate(task.agentId, task.payload?.physicalCleanup?.obligationId);
    return serialize(lock.deviceId, async () => {
      if (terminal(task.status)) return { ok: true, ignored: true };
      if (!isWecomCleanupPending(lock) || lock.physicalCleanup?.verification?.verificationTaskId !== task.taskId
          || task.status !== "running") fail("binding_mismatch");
      return transaction(lock, ({ track }) => {
        track(task); task.status = input.status; task.updatedAt = iso(now());
        if (terminal(task.status)) {
          task.completedAt = task.updatedAt; task.result = { errorCode: String(input.result?.errorCode || "verification_unconfirmed").slice(0, 100) };
          lock.physicalCleanup.phase = "awaiting_verification"; lock.updatedAt = task.updatedAt;
        }
        return { ok: true };
      });
    });
  }
  function lease(agentId, obligationId, fields) {
    const lock = locate(agentId, obligationId), task = verificationTask(lock);
    return Boolean(!committing.has(lock.deviceId) && deviceMatches(lock)
      && wecomVerificationLease(lock, task, fields, agentId, now(),verificationRemaining(lock)) && !conflict(lock, task));
  }
  function leaseProof(agentId,obligationId,fields){const lock=locate(agentId,obligationId);return lease(agentId,obligationId,fields)?{valid:true,remainingMs:verificationRemaining(lock),causalLease:structuredClone(lock.physicalCleanup.verification.causalLease)}:{valid:false};}
  function causalTask(task){return ["wecom_customer_preview",WECOM_CLEANUP_KIND].includes(task?.type)&&Boolean(task.payload?.wecomCausalLease||task.payload?.causalLease);}
  // Dedicated maintenance hook. Never let shared UTC expiry revive/extend or
  // prematurely expire this protocol, and never release its physical hold.
  function expireTask(task){
    if(!causalTask(task)||committing.has(task.deviceId)||terminal(task.status))return false;
    const budget=task.payload?.preinputRecovery?recoveryLeaseState(pending(task.deviceId)):task.type===WECOM_CLEANUP_KIND?verificationLeaseState(pending(task.deviceId)):businessLeaseState(task);
    if(budget.known&&budget.remainingMs>0)return false;
    const code=budget.known?"wecom_cleanup_causal_lease_expired":"wecom_cleanup_causal_context_unconfirmed";
    if(task.status==="stalled"&&task.result?.errorCode===code)return false;
    task.status=budget.known?"failed":"stalled";task.recoverable=false;task.updatedAt=iso(now());
    task.result={...task.result,errorCode:code};if(budget.known)task.completedAt=task.updatedAt;
    if(task.type==="wecom_customer_preview"){
      const {job}=contextFor(task);if(job&&!terminal(job.status)){job.status=task.status;job.updatedAt=task.updatedAt;job.result={...job.result,errorCode:code};if(budget.known)job.completedAt=task.updatedAt;}
      const hold=pending(task.deviceId);if(hold)noteWecomTerminal(hold,task,job,now());
    }
    return true;
  }
  const recoveryScope=lock=>{const v=lock.physicalCleanup.recovery;return {binding:lock.physicalCleanup.binding,verificationId:v.verificationId,verificationNonce:v.verificationNonce,verificationTaskId:v.verificationTaskId};};
  const recoveryTask=lock=>state.windowsTasks.find(t=>t.taskId===lock?.physicalCleanup?.recovery?.verificationTaskId);
  function recoveryBusy(lock,task){
    const d=lock.physicalCleanup,serial=serialKey(d.binding.serial);
    const same=(deviceId,adbSerial)=>deviceId===lock.deviceId||serialKey(adbSerial||state.devices.find(x=>x.deviceId===deviceId)?.adb?.serial)===serial;
    return conflict(lock,task)||state.deviceLocks.some(l=>l.lockId!==lock.lockId&&l.lockId!==d.originalLockId
      &&same(l.deviceId,l.physicalCleanup?.binding?.serial)&&(l.status==='active'||isWecomCleanupPending(l)))
      ||state.windowsTasks.some(t=>t.taskId!==task?.taskId&&t.taskId!==d.binding.originalTaskId&&same(t.deviceId,t.adbSerial)&&!terminal(t.status))
      ||state.automationJobs.some(j=>j.jobId!==d.originalJobId&&same(j.deviceId,j.adbSerial)&&!terminal(j.status));
  }
  function recoveryLeaseState(lock){try{return {known:true,remainingMs:clock.remaining(lock.physicalCleanup.recovery.causalLease,recoveryScope(lock))};}catch{return {known:false,remainingMs:0};}}
  function recoveryValid(lock,task,fields,{queued=false}={}){
    try{
      const v=lock.physicalCleanup.recovery,b=lock.physicalCleanup.binding;
      return isWecomCleanupPending(lock)&&!committing.has(lock.deviceId)&&deviceMatches(lock)
        &&originalRecoveryContext(state,lock).fingerprint===v.request.fingerprint
        &&v.protocol===PREINPUT_RECOVERY&&v.serverEpoch===clock.epoch&&recoveryLeaseState(lock).remainingMs>3000
        &&task?.type===WECOM_CLEANUP_KIND&&task.agentId===b.agentId&&task.deviceId===b.deviceId&&task.adbSerial===b.serial
        &&task.status===(queued?'queued':'running')&&task.payload.preinputRecovery===PREINPUT_RECOVERY
        &&task.taskId===v.verificationTaskId&&isDeepStrictEqual(task.payload.physicalCleanup,b)
        &&isDeepStrictEqual(task.payload.retiredProducer,v.retiredProducer)&&isDeepStrictEqual(task.payload.causalLease,v.causalLease)
        &&['verificationId','verificationNonce','verificationTaskId'].every(k=>fields?.[k]===v[k]&&task.payload[k]===v[k])
        &&(queued||v.pickedAt===task.pickedAt&&Number.isFinite(Date.parse(task.pickedAt)))&&!recoveryBusy(lock,task);
    }catch{return false;}
  }
  function recoveryCanPick(task){const lock=pending(task.deviceId);return Boolean(lock&&recoveryValid(lock,task,task.payload,{queued:true}));}
  function recoveryGet(obligationId){const lock=state.deviceLocks.find(l=>l.lockId===obligationId&&l.lockType===WECOM_CLEANUP_LOCK);return recoveryProposal(state,lock);}
  async function recoveryStart(obligationId,body,operatorId){
    const lock=state.deviceLocks.find(l=>l.lockId===obligationId&&l.lockType===WECOM_CLEANUP_LOCK);
    if(!lock)recoveryFail('request_invalid');
    if(typeof operatorId!=='string'||!operatorId)recoveryFail('operator_required');
    const request=recoveryRequest(body);
    return serialize(lock.deviceId,async()=>{
      const {fingerprint,retiredProducer}=originalRecoveryContext(state,lock),existing=lock.physicalCleanup.recovery;
      if(retiredProducer&&!isDeepStrictEqual(retiredProducer,request.retiredProducer))recoveryFail('producer_invalid');
      const history=lock.physicalCleanup.recoveryHistory||[];
      if(!Array.isArray(history))recoveryFail('attempt_exists');
      const prior=[...history,...(existing?[existing]:[])].find(v=>v.request?.requestId===request.requestId);
      if(prior){
        if(prior.operatorId!==operatorId||!isDeepStrictEqual(prior.request,request))recoveryFail('attempt_exists');
        return {ok:true,reused:true,taskId:prior.verificationTaskId,verified:Boolean(prior.proof&&lock.status==='released')};
      }
      if(existing){
        if(existing.operatorId!==operatorId||request.retryOf!==existing.verificationTaskId)recoveryFail('attempt_exists');
        if(!canRetryRecovery(state,lock))recoveryFail('retry_not_allowed');
      }else if(request.retryOf!==undefined)recoveryFail('request_invalid');
      if(!isWecomCleanupPending(lock)||!deviceMatches(lock)||fingerprint!==request.fingerprint)recoveryFail('context_changed');
      if(recoveryBusy(lock,null))recoveryFail('device_busy');
      const agent=state.windowsAgents?.find(a=>a.agentId===lock.physicalCleanup.binding.agentId);
      const age=now()-Date.parse(agent?.wecomRecoveryAt);
      if(agent?.wecomRecoveryProtocol!==PREINPUT_RECOVERY||!(age>=0&&age<30000))recoveryFail('agent_upgrade_required');
      return transaction(lock,({add})=>{
        const at=iso(now()),v={protocol:PREINPUT_RECOVERY,verificationId:id(),verificationNonce:id(),verificationTaskId:id(),
          serverEpoch:clock.epoch,issuedAt:at,pickedAt:'',operatorId,request,retiredProducer:request.retiredProducer};
        if(existing)lock.physicalCleanup.recoveryHistory=[...history,structuredClone(existing)];
        lock.physicalCleanup.recovery=v;lock.physicalCleanup.phase='maintenance_verifying';lock.updatedAt=at;
        const stamp=clock.mark('verification');
        try{v.causalLease=clock.verificationLease(stamp,recoveryScope(lock));}finally{clock.releaseMark(stamp);}
        add({taskId:v.verificationTaskId,type:WECOM_CLEANUP_KIND,agentId:lock.physicalCleanup.binding.agentId,deviceId:lock.deviceId,
          adbSerial:lock.physicalCleanup.binding.serial,status:'queued',createdAt:at,updatedAt:at,recoverable:false,
          payload:{physicalCleanup:structuredClone(lock.physicalCleanup.binding),preinputRecovery:PREINPUT_RECOVERY,
            verificationId:v.verificationId,verificationNonce:v.verificationNonce,verificationTaskId:v.verificationTaskId,
            issuedAt:at,retiredProducer:structuredClone(v.retiredProducer),causalLease:structuredClone(v.causalLease)},result:{},events:[]});
        return {ok:true,reused:false,taskId:v.verificationTaskId,verified:false};
      });
    });
  }
  function recoveryLease(agentId,obligationId,fields){
    const lock=locate(agentId,obligationId),task=recoveryTask(lock);
    return recoveryExact(fields,['verificationId','verificationNonce','verificationTaskId'])&&recoveryValid(lock,task,fields)
      ?{valid:true,remainingMs:recoveryLeaseState(lock).remainingMs,causalLease:structuredClone(lock.physicalCleanup.recovery.causalLease)}:{valid:false};
  }
  async function recoveryHandle(agentId,obligationId,action,body){
    const lock=locate(agentId,obligationId);
    return serialize(lock.deviceId,async()=>{
      const v=lock.physicalCleanup.recovery,task=recoveryTask(lock);
      if(action==='recovery-proof'&&lock.status==='released'&&v?.proof){
        if(!isDeepStrictEqual(body,v.proof))recoveryFail('proof_invalid');return {ok:true,verified:true,reused:true};
      }
      assertCleanupBinding(lock,body?.binding,agentId);
      if(!recoveryValid(lock,task,body))recoveryFail('lease_lost');
      const result=await transaction(lock,({track,trackLock})=>{
        if(action==='recovery-challenge'){
          if(!recoveryExact(body,['binding','verificationId','verificationNonce','verificationTaskId']))recoveryFail('request_invalid');
          v.challenge=clock.challenge(v.causalLease,recoveryScope(lock));return {ok:true,challenge:structuredClone(v.challenge)};
        }
        if(action!=='recovery-proof')recoveryFail('request_invalid');
        const proof=validateRecoveryProof(body,{binding:lock.physicalCleanup.binding,recovery:v});
        const {original}=originalRecoveryContext(state,lock);
        clock.validateChallenge(proof.challenge,v.causalLease,recoveryScope(lock));
        const at=iso(now());
        // Distinct maintenance evidence; never manufacture original hosts/close,
        // rewrite its failed business result or delete its historical lock.
        v.proof=proof;v.completedAt=at;lock.physicalCleanup.phase='maintenance_verified';
        lock.status='released';lock.releasedAt=lock.updatedAt=at;lock.releaseReason='wecom_preinput_recovery_verified';
        if(original.status==='active'){trackLock(original);original.status='released';original.releasedAt=original.updatedAt=at;original.releaseReason=lock.releaseReason;}
        track(task);task.status='succeeded';task.updatedAt=task.completedAt=at;task.result={cleanupVerified:true,recoveryProtocol:PREINPUT_RECOVERY,obligationId:lock.lockId};
        return {ok:true,verified:true,reused:false};
      });
      if(result.verified)clock.retire(v.causalLease,recoveryScope(lock));return result;
    });
  }
  async function recoveryStatus(task,input){
    if(!['running','failed','cancelled'].includes(input.status))recoveryFail('proof_required');
    const lock=locate(task.agentId,task.payload?.physicalCleanup?.obligationId);
    return serialize(lock.deviceId,async()=>{
      if(terminal(task.status))return {ok:true,ignored:true};
      if(!isWecomCleanupPending(lock)||recoveryTask(lock)!==task||task.status!=='running')recoveryFail('context_changed');
      return transaction(lock,({track})=>{track(task);task.status=input.status;task.updatedAt=iso(now());
        if(terminal(task.status)){task.completedAt=task.updatedAt;task.result={errorCode:String(input.result?.errorCode||'wecom_cleanup_recovery_unconfirmed').slice(0,100)};lock.physicalCleanup.phase='maintenance';lock.updatedAt=task.updatedAt;}
        return {ok:true};});
    });
  }
  return { pending, canPick, picked, noteTerminal, ensureLegacy, handle, lease, leaseProof,reconcile, status, originalReady, checkpoint, checkpointWriting,
    recoveryGet,recoveryStart,recoveryLease,recoveryHandle,
    beginBusinessLease:()=>clock.mark(),finishBusinessCreation:stamp=>clock.releaseMark(stamp),bindBusinessLease,businessRemaining,businessLeaseState,businessLockState,createObligation,causalTask,expireTask };
}
