import fs from "node:fs";
// Preview is deliberately a separate task kind. There is no send option.
export const WECOM_PREVIEW_KIND = "wecom_customer_preview";
export const WECOM_PREVIEW_DEVICES = Object.freeze(JSON.parse(fs.readFileSync(new URL("./wecom-preview-devices.json", import.meta.url), "utf8")));

export function previewTarget(device) {
  const number = String(device?.deviceName || "");
  if (!Object.hasOwn(WECOM_PREVIEW_DEVICES, number)) throw problem("wecom_device_not_allowed", 403);
  const serial = String(device?.adb?.serial || "");
  if (!/^[A-Za-z0-9_.:-]+$/.test(serial) || device.deviceId !== `adb:${serial}` || serial !== WECOM_PREVIEW_DEVICES[number].serial) throw problem("wecom_device_mapping_unconfirmed", 409);
  return { deviceNumber: number, androidUser: WECOM_PREVIEW_DEVICES[number].androidUser };
}

export function previewRequest(input) {
  if (!input || Object.keys(input).some(k => !["deviceId", "phoneNumber", "requestId"].includes(k))) throw problem("invalid_wecom_preview_fields", 400);
  if (typeof input.phoneNumber !== "string" || !/^1[3-9]\d{9}$/.test(input.phoneNumber)) throw problem("invalid_phone_number", 400);
  if (typeof input.deviceId !== "string" || !input.deviceId.startsWith("adb:")) throw problem("device_required", 400);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw problem("invalid_request_id", 400);
  return input;
}

export function publicPreview(job) {
  return { jobId: job.jobId, deviceId: job.deviceId, deviceNumber: job.wecomDeviceNumber,
    androidUser: job.wecomAndroidUser, requestId: job.wecomRequestId, status: job.status,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
    result: { status: job.result?.previewStatus || "", code: job.result?.previewCode || "",
      invitationSent: false, remarkSaveStatus: job.result?.remarkSaveStatus || "not_attempted" } };
}

export function previewLease(task, job, lock, device, agentId, now = Date.now()) {
  try {
    const target = previewTarget(device);
    return Boolean(task?.type === WECOM_PREVIEW_KIND && task.agentId === agentId && task.status === "running"
      && task.deviceId === device.deviceId && task.adbSerial === device.adb.serial
      && job?.kind === WECOM_PREVIEW_KIND && job.status === "running" && job.windowsTaskId === task.taskId
      && job.deviceId === device.deviceId && task.payload?.automationJobId === job.jobId
      && target.deviceNumber === job.wecomDeviceNumber && target.androidUser === job.wecomAndroidUser
      && task.payload?.deviceNumber === target.deviceNumber && task.payload?.androidUser === target.androidUser
      && lock?.status === "active" && lock.lockType === WECOM_PREVIEW_KIND && lock.taskId === job.jobId
      && lock.deviceId === job.deviceId && lock.ownerUserId === job.userId && lock.lockId === job.lockId
      && Date.parse(lock.expiresAt) > now + 3000);
  } catch { return false; }
}

// Serialize only the same submission key, never other phones/tasks. A duplicate
// waits for the first persistence outcome before it can be acknowledged.
export function createPreviewSubmissionGate() {
  const pending = new Map();
  return async (key, fn) => {
    if (pending.has(key)) { await pending.get(key); return fn(); }
    const promise = Promise.resolve().then(fn);
    pending.set(key, promise);
    try { return await promise; } finally { if (pending.get(key) === promise) pending.delete(key); }
  };
}

function problem(code, statusCode) { return Object.assign(new Error(code), { statusCode }); }
