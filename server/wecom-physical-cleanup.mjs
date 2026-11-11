import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { WECOM_CAUSAL_PROTOCOL } from "./wecom-causal-clock.mjs";

export const WECOM_CLEANUP_KIND = "wecom_cleanup_verify";
export const WECOM_CLEANUP_LOCK = "wecom_physical_cleanup";
export const WECOM_PACKAGES = Object.freeze(["com.netease.open.pocoservice", "com.netease.open.pocoservice.test"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const bindingKeys = ["version", "obligationId", "originalTaskId", "executionId", "deviceId", "serial", "agentId", "appSlot", "androidUser", "nonce"];
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(`wecom_cleanup_${code}`), { statusCode }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = now => new Date(now).toISOString();
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export const isWecomCleanupPending = lock => lock?.lockType === WECOM_CLEANUP_LOCK && lock.status !== "released";
export const pendingWecomCleanup = (locks, deviceId) => (locks || []).find(lock => lock.deviceId === deviceId && isWecomCleanupPending(lock)) || null;

// Independent of job/task retention and ordinary lock TTL. No far-future expiry.
export function createWecomCleanupObligation(task, job, device, { now = Date.now(), id = randomUUID } = {}) {
  if (task?.type !== "wecom_customer_preview" || !job || !device
    || task.deviceId !== device.deviceId || task.agentId !== device.adb?.agentId
    || task.adbSerial !== device.adb?.serial || job.deviceId !== device.deviceId
    || task.payload?.automationJobId !== job.jobId) fail("binding_mismatch");
  const obligationId = id();
  const binding = { version: 1, obligationId, originalTaskId: task.taskId, executionId: id(),
    deviceId: device.deviceId, serial: task.adbSerial, agentId: task.agentId,
    appSlot: job.wecomAppSlot || (job.wecomAndroidUser === 0 ? "main" : "clone"),
    androidUser: job.wecomAndroidUser, nonce: id() };
  if (!binding.originalTaskId || !["main", "clone"].includes(binding.appSlot) || !Number.isSafeInteger(binding.androidUser)) fail("binding_mismatch");
  return { lockId: obligationId, taskId: obligationId, lockType: WECOM_CLEANUP_LOCK, status: "cleanup_pending",
    deviceId: device.deviceId, appSlot: binding.appSlot, ownerUserId: job.userId || "", expiresAt: "",
    createdAt: iso(now), updatedAt: iso(now), physicalCleanup: { binding,
      originalJobId: job.jobId, originalLockId: job.lockId || "", phase: "awaiting_host",
      originalTerminalAt: "", hosts: null, hostClosedAt: "", verification: null } };
}

export function assertCleanupBinding(lock, binding, agentId) {
  if (!lock?.physicalCleanup?.binding || lock.physicalCleanup.binding.agentId !== agentId
      || !exactKeys(binding, bindingKeys) || !isDeepStrictEqual(lock.physicalCleanup.binding, binding)) fail("binding_mismatch");
  return lock.physicalCleanup;
}

export function validateWecomHosts(hosts, now = Date.now()) {
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 8) fail("host_invalid", 400);
  const roles = new Set(); const pids = new Set();
  for (const host of hosts) {
    if (!exactKeys(host, ["role", "pid", "createdAt", "creationToken", "machineId"]) || !/^[a-z][a-z0-9_]{0,31}$/.test(host.role)
      || !Number.isSafeInteger(host.pid) || host.pid <= 0 || host.pid > 0xffffffff || pids.has(host.pid) || roles.has(host.role)
      || typeof host.machineId !== "string" || !/^[a-f0-9]{64}$/.test(host.machineId) || host.machineId !== hosts[0].machineId
      || !validTime(host.createdAt)
      || typeof host.creationToken !== "string" || !/^0x1\.[0-9a-f]{13}p\+\d+$/.test(host.creationToken)) fail("host_invalid", 400);
    roles.add(host.role); pids.add(host.pid);
  }
  if (!roles.has("reader")) fail("host_invalid", 400);
  return structuredClone(hosts);
}

export function recordWecomHosts(lock, body, task, now = Date.now()) {
  if (!exactKeys(body, ["binding", "hosts", "bootstrap"])) fail("host_invalid", 400);
  const duty = lock.physicalCleanup;
  if (duty.causal?.protocol !== WECOM_CAUSAL_PROTOCOL
      || !exactKeys(body.bootstrap, ["protocol", "bindingNonce", "pipeNonce"])
      || body.bootstrap.protocol !== WECOM_CAUSAL_PROTOCOL || body.bootstrap.bindingNonce !== duty.binding.nonce
      || typeof body.bootstrap.pipeNonce !== "string" || !/^[a-f0-9]{48}$/.test(body.bootstrap.pipeNonce)) fail("host_unconfirmed");
  const hosts = validateWecomHosts(body.hosts, now);
  if (duty.hosts) {
    if (!isDeepStrictEqual(duty.hosts, hosts) || !isDeepStrictEqual(duty.causal.bootstrap, body.bootstrap)) fail("binding_mismatch");
    return;
  }
  if (!isWecomCleanupPending(lock) || task?.status !== "running" || task.taskId !== duty.binding.originalTaskId
      || duty.originalTerminalAt) fail("host_unconfirmed");
  duty.causal.bootstrap = structuredClone(body.bootstrap);
  duty.hosts = hosts; duty.phase = "awaiting_host_close"; lock.updatedAt = iso(now);
}

export function recordWecomHostClosed(lock, body, now = Date.now()) {
  if (!exactKeys(body, ["binding", "hosts", "bootstrap", "observedAt", "exited", "observerMachineId"])) fail("host_invalid", 400);
  const duty = lock.physicalCleanup;
  if (!duty.hosts || !isDeepStrictEqual(duty.hosts, body.hosts) || body.exited !== true
      || body.observerMachineId !== duty.hosts[0].machineId
      || duty.causal?.protocol !== WECOM_CAUSAL_PROTOCOL || !isDeepStrictEqual(body.bootstrap, duty.causal.bootstrap)
      || !validTime(body.observedAt)) fail("host_unconfirmed");
  if (duty.hostClosedAt) {
    if (duty.hostClosedAt !== body.observedAt) fail("binding_mismatch");
    return;
  }
  if (!isWecomCleanupPending(lock)) fail("binding_mismatch");
  duty.hostClosedAt = body.observedAt; duty.phase = "awaiting_verification"; lock.updatedAt = iso(now);
}

export function noteWecomTerminal(lock, task, job, now = Date.now()) {
  if (!isWecomCleanupPending(lock) || !lock.physicalCleanup) return false;
  const duty = lock.physicalCleanup;
  if (task?.taskId !== duty.binding?.originalTaskId && job?.jobId !== duty.originalJobId) return false;
  if (!TERMINAL.has(task?.status) && !TERMINAL.has(job?.status)) return false;
  if (!duty.originalTerminalAt) { duty.originalTerminalAt = iso(now); lock.updatedAt = iso(now); }
  return true;
}

export function createWecomVerification(lock, { now = Date.now(), id = randomUUID } = {}) {
  const duty = lock.physicalCleanup;
  if (!isWecomCleanupPending(lock) || !duty?.originalTerminalAt) fail("not_terminal");
  if (!duty.hostClosedAt || !duty.hosts) fail("host_unconfirmed");
  const taskId = id();
  const verification = { verificationId: id(), verificationNonce: id(), verificationTaskId: taskId,
    issuedAt: iso(now), expiresAt: iso(now + 120_000), pickedAt: "" };
  duty.verification = verification; duty.phase = "verifying"; lock.updatedAt = iso(now);
  return { taskId, type: WECOM_CLEANUP_KIND, agentId: duty.binding.agentId, deviceId: lock.deviceId,
    adbSerial: duty.binding.serial, status: "queued", createdAt: iso(now), updatedAt: iso(now), recoverable: false,
    payload: { physicalCleanup: structuredClone(duty.binding), ...structuredClone(verification), hosts: structuredClone(duty.hosts) }, result: {}, events: [] };
}

export function wecomVerificationLease(lock, task, fields, agentId, now = Date.now(), remainingMs = null) {
  const duty = lock?.physicalCleanup, v = duty?.verification;
  return Boolean(isWecomCleanupPending(lock) && duty.hostClosedAt && duty.originalTerminalAt && v
    && duty.binding.agentId === agentId && task?.type === WECOM_CLEANUP_KIND && task.status === "running"
    && task.agentId === agentId && task.deviceId === lock.deviceId && task.adbSerial === duty.binding.serial
    && isDeepStrictEqual(task.payload?.physicalCleanup, duty.binding)
    && ["verificationId", "verificationNonce", "verificationTaskId"].every(k => fields?.[k] === v[k] && task.payload?.[k] === v[k])
    && task.taskId === v.verificationTaskId && v.pickedAt === task.pickedAt && validTime(v.pickedAt)
    && duty.causal?.protocol === WECOM_CAUSAL_PROTOCOL && isDeepStrictEqual(v.causalLease, task.payload.causalLease)
    && Number.isSafeInteger(remainingMs) && remainingMs > 0);
}

export function validateWecomProof(lock, task, body, agentId, now = Date.now(), remainingMs = null) {
  assertCleanupBinding(lock, body?.binding, agentId);
  if (!exactKeys(body, ["binding", "verificationId", "verificationNonce", "verificationTaskId", "challenge", "snapshots"])) fail("proof_invalid", 400);
  if (!wecomVerificationLease(lock, task, body, agentId, now, remainingMs)) fail("proof_invalid");
  const duty = lock.physicalCleanup;
  if (!Array.isArray(body.snapshots) || body.snapshots.length !== 2) fail("proof_invalid");
  if (!duty.verification.challenge || !isDeepStrictEqual(body.challenge, duty.verification.challenge)) fail("proof_invalid");
  let previous = -1;
  for (const [index, frame] of body.snapshots.entries()) {
    if (!exactKeys(frame, ["sequence", "elapsedMs", "observedAt", "packagesAbsent", "packageNames", "serialForwardCount"])
      || frame.packagesAbsent !== true || frame.serialForwardCount !== 0
      || !isDeepStrictEqual(frame.packageNames, WECOM_PACKAGES) || !validTime(frame.observedAt)) fail("proof_invalid");
    if (frame.sequence !== index + 1 || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0
        || frame.elapsedMs <= previous || frame.elapsedMs > 3000) fail("proof_invalid");
    previous = frame.elapsedMs;
  }
  return structuredClone(body);
}

export function completeWecomVerification(lock, task, proof, now = Date.now()) {
  // Call only after validation, while the physical-device gate is held, and
  // persist this lock + task together before opening that gate.
  const at = iso(now);
  lock.physicalCleanup.phase = "verified"; lock.physicalCleanup.proof = structuredClone(proof);
  lock.status = "released"; lock.releasedAt = at; lock.updatedAt = at; lock.releaseReason = "wecom_physical_verified";
  task.status = "succeeded"; task.updatedAt = at; task.completedAt = at;
  task.result = { cleanupVerified: true, obligationId: lock.lockId };
}

export function publicWecomCleanupState(lock) {
  const allowed = new Set(["awaiting_host", "awaiting_host_close", "awaiting_verification", "verifying", "maintenance"]);
  const duty = lock?.physicalCleanup;
  const missingHost = Boolean(duty?.originalTerminalAt && !duty.hosts);
  const missingClose = Boolean(duty?.originalTerminalAt && duty.hosts && !duty.hostClosedAt);
  const phase = missingHost || missingClose ? "maintenance" : allowed.has(duty?.phase) ? duty.phase : "maintenance";
  return { phase, label: phase === "maintenance" ? "企微清理待确认 · 需单机维护" : "企微清理待确认",
    ...(missingHost ? { reason: "host_evidence_missing" } : missingClose ? { reason: "host_close_unconfirmed" } : {}) };
}
