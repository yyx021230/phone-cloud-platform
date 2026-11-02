import fs from "node:fs";
import { createHash } from "node:crypto";
import { wecomExecution } from "./wecom-diagnostics.mjs";
// Retain the historical task kind and routes; execution mode is explicitly bound.
export const WECOM_PREVIEW_KIND = "wecom_customer_preview";
export const WECOM_PREVIEW_DEVICES = Object.freeze(JSON.parse(fs.readFileSync(new URL("./wecom-preview-devices.json", import.meta.url), "utf8")));

export function previewTarget(device, appSlot) {
  const number = String(device?.deviceName || "");
  if (!Object.hasOwn(WECOM_PREVIEW_DEVICES, number)) throw problem("wecom_device_not_allowed", 403);
  const serial = String(device?.adb?.serial || "");
  if (!/^[A-Za-z0-9_.:-]+$/.test(serial) || device.deviceId !== `adb:${serial}` || serial !== WECOM_PREVIEW_DEVICES[number].serial) throw problem("wecom_device_mapping_unconfirmed", 409);
  const entry = WECOM_PREVIEW_DEVICES[number];
  const selected = appSlot === undefined ? entry.defaultAppSlot : appSlot;
  if (!["main", "clone"].includes(selected)) throw problem("invalid_wecom_app_slot", 400);
  if (!Object.hasOwn(entry.appSlots, selected)) throw problem("wecom_app_slot_not_configured", 409);
  return { deviceNumber: number, appSlot: selected, androidUser: entry.appSlots[selected] };
}

export function previewSlots(device) {
  const target = previewTarget(device);
  return Object.keys(WECOM_PREVIEW_DEVICES[target.deviceNumber].appSlots).map(slot => previewTarget(device, slot));
}

// Records created before slots were introduced retain their original user.
export function previewJobSlot(job) { return job.wecomAppSlot ?? (job.wecomAndroidUser === 0 ? "main" : "clone"); }

export function previewRemarkInput(input) {
  const normalize = (key, fallback, limit) => {
    if (input[key] === undefined) return fallback;
    if (typeof input[key] !== "string") throw problem("invalid_wecom_" + key, 400);
    const value = (key === "description" ? input[key].replace(/\r\n?/g, "\n") : input[key]).trim();
    const forbidden = key === "description" ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ud800-\udfff]/u : /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u;
    if ([...value].length > limit || forbidden.test(value)) throw problem("invalid_wecom_" + key, 400);
    return value || fallback;
  };
  return { remarkName: normalize("remarkName", "测试客户", 20), description: normalize("description", "接口联调测试", 120) };
}
export function previewJobRemarks(job) { return previewRemarkInput({ remarkName: job.wecomRemarkName, description: job.wecomDescription }); }
export function previewRemarkFingerprint(job) {
  const value = previewJobRemarks(job);
  return createHash("sha256").update(JSON.stringify([value.remarkName, value.description])).digest("hex");
}

export function previewJobMode(job) { return job.wecomMode || "preview"; }
export function previewOperationFingerprint(job) {
  return createHash("sha256").update(JSON.stringify([previewJobMode(job), previewRemarkFingerprint(job), job.phoneNumber, job.deviceId, job.wecomAndroidUser])).digest("hex");
}
export function previewSendState(job) {
  return job.wecomSendClaimAt || (previewJobMode(job) === "send" && job.result?.sendStatus === "unknown") ? "unknown" : "not_attempted";
}
export function sameWecomRecipient(job, other) {
  return other.kind === WECOM_PREVIEW_KIND && previewJobMode(other) === "send"
    && job.deviceId === other.deviceId && job.wecomAndroidUser === other.wecomAndroidUser && job.phoneNumber === other.phoneNumber;
}
export function previewRequest(input) {
  if (!input || Object.keys(input).some(k => !["deviceId", "phoneNumber", "requestId", "appSlot", "remarkName", "description", "mode"].includes(k))) throw problem("invalid_wecom_preview_fields", 400);
  if (input.mode !== undefined && !["preview", "send"].includes(input.mode)) throw problem("invalid_wecom_mode", 400);
  if (Object.hasOwn(input, "appSlot") && !["main", "clone"].includes(input.appSlot)) throw problem("invalid_wecom_app_slot", 400);
  if (typeof input.phoneNumber !== "string" || !/^1[3-9]\d{9}$/.test(input.phoneNumber)) throw problem("invalid_phone_number", 400);
  if (typeof input.deviceId !== "string" || !input.deviceId.startsWith("adb:")) throw problem("device_required", 400);
  if (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw problem("invalid_request_id", 400);
  return { ...input, ...previewRemarkInput(input) };
}

export function publicPreview(job) {
  const execution = wecomExecution(job.result?.diagnostic?.wecomExecution);
  return { jobId: job.jobId, deviceId: job.deviceId, deviceNumber: job.wecomDeviceNumber,
    mode: previewJobMode(job), appSlot: previewJobSlot(job), androidUser: job.wecomAndroidUser, requestId: job.wecomRequestId, status: job.status,
    createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
    result: { status: job.result?.previewStatus || "", code: job.result?.previewCode || "",
      invitationSent: previewSendState(job) === "unknown" ? null : false, sendStatus: previewSendState(job), sendClaimed: Boolean(job.wecomSendClaimAt), remarkSaveStatus: job.result?.remarkSaveStatus || "not_attempted",
      ...(execution ? { execution } : {}) } };
}

export function previewLease(task, job, lock, device, agentId, now = Date.now(), remainingMs = null) {
  try {
    const target = previewTarget(device, previewJobSlot(job));
    const requested = previewJobRemarks(job), delivered = previewRemarkInput(task?.payload || {});
    return Boolean(task?.type === WECOM_PREVIEW_KIND && task.agentId === agentId && task.status === "running"
      && task.deviceId === device.deviceId && task.adbSerial === device.adb.serial && device.adb.agentId === agentId
      && job?.kind === WECOM_PREVIEW_KIND && job.status === "running" && job.windowsTaskId === task.taskId
      && job.deviceId === device.deviceId && task.payload?.automationJobId === job.jobId
      && task.payload?.phoneNumber === job.phoneNumber
      && target.deviceNumber === job.wecomDeviceNumber && target.androidUser === job.wecomAndroidUser
      && (job.wecomAppSlot === undefined ? task.payload?.appSlot === undefined : task.payload?.appSlot === target.appSlot)
      && previewJobMode(job) === (task.payload?.mode || "preview")
      && (previewJobMode(job) !== "send" || task.payload?.previewOnly === false)
      && requested.remarkName === delivered.remarkName && requested.description === delivered.description
      && task.payload?.deviceNumber === target.deviceNumber && task.payload?.androidUser === target.androidUser
      && lock?.status === "active" && lock.lockType === WECOM_PREVIEW_KIND && lock.taskId === job.jobId
      && lock.deviceId === job.deviceId && lock.ownerUserId === job.userId && lock.lockId === job.lockId
      && Number.isSafeInteger(remainingMs) && remainingMs > 3000);
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

// Integration facade: public phone number, configured application slot, target
// customer and remark. Execution details remain in the existing leased task.
export function invitationRequest(input, devices, { requestId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(k => !["deviceNumber", "appSlot", "phoneNumber", "remarkName"].includes(k))) throw problem("invalid_wecom_invitation_fields", 400);
  const number = typeof input.deviceNumber === "number" && Number.isInteger(input.deviceNumber) ? String(input.deviceNumber) : input.deviceNumber;
  if (typeof number !== "string" || !/^[1-9]\d{0,2}$/.test(number)) throw problem("invalid_wecom_device_number", 400);
  if (!Object.hasOwn(WECOM_PREVIEW_DEVICES, number)) throw problem("wecom_device_not_allowed", 403);
  const matches = devices.filter(d => d.deviceName === number);
  if (matches.length !== 1) throw problem("wecom_device_number_not_unique", 409);
  const entry = WECOM_PREVIEW_DEVICES[number];
  if (input.appSlot === undefined && Object.keys(entry.appSlots).length > 1) throw problem("wecom_app_slot_required", 400);
  const target = previewTarget(matches[0], input.appSlot);
  return previewRequest({ deviceId: matches[0].deviceId, appSlot: target.appSlot, phoneNumber: input.phoneNumber,
    ...(input.remarkName === undefined ? {} : { remarkName: input.remarkName }), mode: "send",
    requestId });
}

export function holdInvitation(job) {
  return ["queued", "running", "stalled"].includes(job.status) || previewSendState(job) === "unknown" || job.result?.remarkSaveStatus === "unknown";
}

export function publicInvitation(task) {
  const active = ["queued", "running"].includes(task.status);
  const code = task.result?.code || (task.status === "expired" ? "task_expired" : "");
  const needsHuman = /(?:human|login_required|not_ready|poco_already_running|lease_lost)/.test(code);
  const unknown = !active && (task.result?.sendStatus === "unknown" || task.status === "stalled" || task.result?.remarkSaveStatus === "unknown");
  const status = active ? task.status : unknown ? "unknown" : needsHuman ? "needs_attention" : "failed";
  const message = status === "queued" ? "任务已受理，等待执行" : status === "running" ? "正在添加客户"
    : status === "unknown" ? "执行结果待核对，请勿重复发送"
    : status === "needs_attention" ? "请在对应手机处理登录或验证，再核对原任务"
    : "本次任务未完成，请根据错误码核对";
  const execution = wecomExecution(task.result?.execution);
  return { taskId: task.jobId, deviceNumber: task.deviceNumber, appSlot: task.appSlot, status, code, message,
    ...(execution ? { execution } : {}) };
}

// A small inventory view for integration clients. No SIM/customer/ADB identity
// or task owner data is carried into this projection.
export function publicWecomDevice(device, { online = false, adbOnline = false, agentOnline = false,
  listed = false, occupancy = null, mappingCount = 1 } = {}) {
  const name = String(device.deviceName || "");
  const deviceNumber = /^[1-9]\d{0,2}$/.test(name) ? name : null;
  let slots = [], allowed = false;
  try { slots = previewSlots(device); allowed = mappingCount === 1; } catch { /* Not a configured WeCom phone. */ }
  if (!allowed) slots = [];
  const busy = Boolean(occupancy);
  const reason = !allowed ? (mappingCount > 1 && Object.hasOwn(WECOM_PREVIEW_DEVICES, name) ? "device_number_conflict" : "wecom_not_configured")
    : !listed ? "device_not_listed" : !adbOnline ? "adb_offline" : !agentOnline ? "agent_offline" : busy ? "device_busy" : "";
  const occupation = occupancy ? { type: occupancy.kind || "device_task",
    label: occupancy.kind === WECOM_PREVIEW_KIND ? "企微加客户" : occupancy.label || "设备任务" } : null;
  return { deviceNumber, deviceName: name, online, adbOnline, agentOnline, listed,
    busy, busyReason: occupation?.label || "", occupancy: occupation,
    wecomAllowed: allowed, appSlots: slots.map(s => ({ appSlot: s.appSlot, label: s.appSlot === "clone" ? "分身" : "主应用" })),
    available: reason === "", unavailableReason: reason,
    model: device.model || "", brand: device.brand || device.adb?.brand || "", androidVersion: device.androidVersion || "",
    batteryLevel: device.batteryLevel ?? null, lastSeenAt: device.lastSeenAt || null, adbLastSeenAt: device.adb?.lastSeenAt || null };
}
