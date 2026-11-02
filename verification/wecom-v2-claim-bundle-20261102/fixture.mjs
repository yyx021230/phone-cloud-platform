// Synthetic standalone queued records; no real phone/config lookup or I/O.
import { createHash } from "node:crypto";
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function independentBusinessFingerprint(job) {
  return sha([job.wecomMode, sha([job.wecomRemarkName, job.wecomDescription]), job.phoneNumber, job.deviceId, job.wecomAndroidUser]);
}
export function fixture({ suffix = "one", slot = "main", mode = "preview", serial = "fixture" } = {}) {
  const deviceNumber = slot === "main" ? "23" : "155", androidUser = slot === "main" ? 0 : 999;
  const binding = { version: 2, obligationId: `physical-${suffix}`, originalTaskId: `task-${suffix}`, executionId: `execution-${suffix}`,
    deviceId: `adb:${serial}`, serial, agentId: "fixture-agent", appSlot: slot, androidUser,
    nonce: `binding-${suffix}`, serverEpoch: "fixture-server-epoch", agentInstanceId: "fixture-parent-instance", handshakeNonce: `spawn-${suffix}` };
  const job = { jobId: `job-${suffix}`, kind: "wecom_customer_preview", userId: "fixture-owner", deviceId: binding.deviceId,
    sessionId: "", xhsAppSlot: "", windowsTaskId: binding.originalTaskId, agentId: binding.agentId, adbSerial: serial,
    status: "queued", pickedAt: null, completedAt: null, createdAt: "2026-11-02T05:00:00.000Z", updatedAt: "2026-11-02T05:00:00.000Z",
    result: {}, events: [], lockId: `business-${suffix}`, phoneNumber: "13900000000", wecomMode: mode,
    wecomRequestId: `fixture_request_${suffix}`, wecomDeviceNumber: deviceNumber, wecomAppSlot: slot, wecomAndroidUser: androidUser,
    wecomRemarkName: "测试客户", wecomDescription: "接口联调测试", wecomCleanupProtocol: 2 };
  const task = { taskId: binding.originalTaskId, type: job.kind, agentId: binding.agentId, deviceId: binding.deviceId, adbSerial: serial,
    status: "queued", pickedAt: null, completedAt: null, result: {}, events: [], createdAt: job.createdAt, updatedAt: job.updatedAt,
    payload: { automationJobId: job.jobId, automationSessionId: "", wecomCleanupProtocol: 2, deviceNumber, appSlot: slot, androidUser,
      mode, previewOnly: mode === "preview", phoneNumber: job.phoneNumber, remarkName: job.wecomRemarkName, description: job.wecomDescription, xhsAppSlot: "" } };
  const businessLock = { lockId: job.lockId, lockType: job.kind, deviceId: binding.deviceId, appSlot: "", taskId: job.jobId,
    ownerUserId: job.userId, status: "active", createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: "2026-11-02T05:05:00.000Z", releasedAt: "", releaseReason: "" };
  const device = { deviceId: binding.deviceId, deviceName: deviceNumber, adb: { serial, agentId: binding.agentId }, lastSeenAt: job.createdAt };
  const context = { binding, claimOperationId: `claim-${suffix}`, originalJobId: job.jobId, originalLockId: job.lockId,
    ownerUserId: job.userId, requestId: job.wecomRequestId, mode, target: { deviceNumber, appSlot: slot, androidUser },
    businessFingerprint: independentBusinessFingerprint(job), recordedAt: "2026-11-02T05:00:01.000Z" };
  return { context, input: { task, job, businessLock, device } };
}
