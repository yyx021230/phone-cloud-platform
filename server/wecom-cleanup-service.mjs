import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { WECOM_CLEANUP_KIND, WECOM_CLEANUP_LOCK, isWecomCleanupPending,
  pendingWecomCleanup, assertCleanupBinding, recordWecomHosts, recordWecomHostClosed,
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
export function createWecomCleanupService({ state, persist, conflict = () => false, now = Date.now, id = randomUUID }) {
  const queues = new Map(), committing = new Map(), checkpointFences = new Map();
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
  function verificationTask(lock) {
    return state.windowsTasks.find(t => t.taskId === lock.physicalCleanup?.verification?.verificationTaskId);
  }
  function deviceMatches(lock) {
    const binding = lock.physicalCleanup?.binding;
    const device = state.devices.find(d => d.deviceId === lock.deviceId);
    return Boolean(binding && device?.adb?.serial === binding.serial && device.adb.agentId === binding.agentId);
  }
  function originalReady(task) {
    if (!task?.payload?.physicalCleanup) return true; // explicitly old protocol
    const lock = pending(task.deviceId);
    return Boolean(lock && !committing.has(lock.deviceId) && deviceMatches(lock)
      && isDeepStrictEqual(lock.physicalCleanup.binding, task.payload.physicalCleanup)
      && lock.physicalCleanup.hosts && !lock.physicalCleanup.hostClosedAt
      && !lock.physicalCleanup.originalTerminalAt && task.status === "running");
  }
  function canPick(task) {
    const lock = pending(task.deviceId) || [...committing.values(), ...(state.deviceLocks || [])].find(l => isWecomCleanupPending(l)
      && serialKey(l.physicalCleanup?.binding?.serial || l.physicalCleanup?.legacySerial || state.devices.find(d => d.deviceId === l.deviceId)?.adb?.serial) === serialKey(task.adbSerial) && serialKey(task.adbSerial));
    if (!lock) return task.type !== WECOM_CLEANUP_KIND;
    if (committing.has(lock.deviceId) || task.type !== WECOM_CLEANUP_KIND) return false;
    const v = lock.physicalCleanup?.verification;
    return Boolean(v && v.verificationTaskId === task.taskId && task.status === "queued"
      && Date.parse(v.expiresAt) > now() && deviceMatches(lock)
      && isDeepStrictEqual(task.payload?.physicalCleanup, lock.physicalCleanup.binding)
      && !conflict(lock, task));
  }
  function picked(task) {
    if (task.type !== WECOM_CLEANUP_KIND) return null;
    const lock = pendingWecomCleanup(state.deviceLocks, task.deviceId);
    if (!lock || lock.physicalCleanup?.verification?.verificationTaskId !== task.taskId) fail("binding_mismatch");
    lock.physicalCleanup.verification.pickedAt = task.pickedAt;
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
      if (!isWecomCleanupPending(lock)) fail("binding_mismatch");
      return transaction(lock, ({ track, trackLock, add }) => {
        const { task, job } = execution(lock);
        noteWecomTerminal(lock, task, job, now());
        if (action === "host") { recordWecomHosts(lock, body, task, now()); return { ok: true }; }
        if (action === "host-closed") { recordWecomHostClosed(lock, body, now()); return { ok: true }; }
        if (action === "verify") {
          if (!exact(body, ["binding"])) fail("binding_mismatch");
          if (!lock.physicalCleanup.originalTerminalAt) fail("not_terminal");
          if (!lock.physicalCleanup.hostClosedAt) fail("host_unconfirmed");
          const existing = verificationTask(lock);
          if (existing && !terminal(existing.status) && Date.parse(lock.physicalCleanup.verification.expiresAt) > now()) {
            return { ok: true, reused: true, taskId: existing.taskId };
          }
          if (conflict(lock, existing)) fail("device_busy");
          if (existing && !terminal(existing.status)) {
            track(existing); existing.status = "expired"; existing.updatedAt = existing.completedAt = iso(now());
          }
          const verification = add(createWecomVerification(lock, { now: now(), id }));
          return { ok: true, taskId: verification.taskId, reused: false };
        }
        if (action === "proof") {
          const verification = verificationTask(lock);
          if (conflict(lock, verification)) fail("device_busy");
          const proof = validateWecomProof(lock, verification, body, agentId, now());
          const originalLock = state.deviceLocks.find(l => l.lockId === lock.physicalCleanup.originalLockId);
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
    });
  }
  // Recover one missed request after restart/outbox delay. Never loop failed
  // verification generations or replay the original business task.
  async function reconcile(agentId) {
    const lock = state.deviceLocks.find(l => isWecomCleanupPending(l)
      && l.physicalCleanup?.binding?.agentId === agentId && l.physicalCleanup.hostClosedAt
      && !l.physicalCleanup.verification && deviceMatches(l) && !conflict(l, null)
      && (l.physicalCleanup.originalTerminalAt || terminal(execution(l).task?.status) || terminal(execution(l).job?.status)));
    if (!lock) return null;
    return handle(agentId, lock.lockId, "verify", { binding: structuredClone(lock.physicalCleanup.binding) });
  }
  async function status(task, input) {
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
      && wecomVerificationLease(lock, task, fields, agentId, now()) && !conflict(lock, task));
  }
  return { pending, canPick, picked, noteTerminal, ensureLegacy, handle, lease, reconcile, status, originalReady, checkpoint, checkpointWriting };
}
