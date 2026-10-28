const ACTIVE_SCREEN_SESSION_STATUSES = new Set(["connecting", "ready", "streaming"]);

export const SCREEN_GALLERY_DELIVERY_PROTOCOL = "gallery_v2";
export const XHS_PUBLISH_DELIVERY_PROTOCOL = "xhs_publish_v1";

function deliveryProfile(task) {
  if (task?.type === "screen_gallery_import") {
    return {
      payloadKeys: ["imageDataUrl"],
      missingError: "screen_gallery_payload_missing",
      failedError: "screen_gallery_delivery_failed",
      failedMessage: (attempt) => `图片任务连续 ${attempt} 次未能完整交付给 Windows 管理器，请重试`
    };
  }
  if (task?.type === "xhs_publish") {
    return {
      payloadKeys: ["imageDataUrls"],
      missingError: "xhs_publish_payload_missing",
      failedError: "xhs_publish_delivery_failed",
      failedMessage: (attempt) => `发布任务连续 ${attempt} 次未能完整交付给 Windows 管理器，请重试`
    };
  }
  return null;
}

export function supportsLeasedWindowsTaskDelivery(task) {
  return Boolean(deliveryProfile(task));
}

function deliveryTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function canQueueScreenGalleryImport(session, ctx) {
  return Boolean(
    session
    && ctx
    && ACTIVE_SCREEN_SESSION_STATUSES.has(String(session.status || ""))
    && String(session.userId || "") === String(ctx.userId || "")
  );
}

export function publicScreenGalleryImportTask(task) {
  const result = task?.result && typeof task.result === "object" ? task.result : {};
  return {
    taskId: String(task?.taskId || ""),
    status: String(task?.status || "queued"),
    createdAt: String(task?.createdAt || ""),
    updatedAt: String(task?.updatedAt || ""),
    completedAt: String(task?.completedAt || ""),
    result: {
      message: String(result.message || result.error || ""),
      remotePath: String(result.remotePath || "")
    }
  };
}

export function hasActiveScreenGalleryDelivery(task, nowMs = Date.now()) {
  return Boolean(
    deliveryProfile(task)
    && task?.status === "queued"
    && task?.delivery?.token
    && deliveryTime(task.delivery.expiresAt) > Number(nowMs)
  );
}

export function issueScreenGalleryDelivery(task, options = {}) {
  const profile = deliveryProfile(task);
  if (!profile || task?.status !== "queued") {
    throw new Error("screen_gallery_delivery_not_queueable");
  }
  const nowMs = Number(options.nowMs ?? Date.now());
  const leaseMs = Math.max(5_000, Number(options.leaseMs || 60_000));
  const token = String(options.token || "");
  if (!token) throw new Error("screen_gallery_delivery_token_required");
  const attempt = Math.max(0, Number(task.deliveryAttempts || task.delivery?.attempt || 0)) + 1;
  const leasedAt = new Date(nowMs).toISOString();
  task.delivery = {
    token,
    attempt,
    leasedAt,
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
    ackedAt: ""
  };
  task.deliveryAttempts = attempt;
  task.updatedAt = leasedAt;
  const responseTask = structuredClone(task);
  responseTask.payload = { ...(responseTask.payload || {}) };
  for (const key of profile.payloadKeys) delete responseTask.payload[key];
  delete responseTask.delivery;
  responseTask.deliveryToken = token;
  responseTask.deliveryAttempt = attempt;
  return responseTask;
}

export function readScreenGalleryDeliveryPayload(task, token, nowMs = Date.now()) {
  const profile = deliveryProfile(task);
  if (!profile) return { ok: false, error: "windows_task_payload_not_found" };
  if (task?.status !== "queued") return { ok: false, error: "screen_gallery_delivery_not_queued" };
  if (!hasActiveScreenGalleryDelivery(task, nowMs)) return { ok: false, error: "screen_gallery_delivery_expired" };
  if (!token || String(task.delivery?.token || "") !== String(token)) return { ok: false, error: "screen_gallery_delivery_token_invalid" };
  if (profile.payloadKeys.some((key) => !task.payload?.[key])) return { ok: false, error: profile.missingError };
  const payload = {};
  for (const key of profile.payloadKeys) payload[key] = task.payload[key];
  if (task.type === "screen_gallery_import") payload.screenSessionId = String(task.payload.screenSessionId || "");
  return {
    ok: true,
    payload
  };
}

export function acknowledgeScreenGalleryDelivery(task, token, nowMs = Date.now()) {
  const normalizedToken = String(token || "");
  if (!deliveryProfile(task)) return { ok: false, error: "windows_task_delivery_not_found" };
  if (task.status === "running" && normalizedToken && task.delivery?.token === normalizedToken && task.delivery?.ackedAt) {
    return { ok: true, idempotent: true };
  }
  if (task.status !== "queued") return { ok: false, error: "screen_gallery_delivery_not_queued" };
  if (!hasActiveScreenGalleryDelivery(task, nowMs)) return { ok: false, error: "screen_gallery_delivery_expired" };
  if (!normalizedToken || task.delivery?.token !== normalizedToken) return { ok: false, error: "screen_gallery_delivery_token_invalid" };
  const acknowledgedAt = new Date(Number(nowMs)).toISOString();
  task.status = "running";
  task.pickedAt = task.pickedAt || acknowledgedAt;
  task.updatedAt = acknowledgedAt;
  task.delivery.ackedAt = acknowledgedAt;
  return { ok: true, idempotent: false };
}

export function maintainScreenGalleryDeliveries(tasks = [], options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const changedTasks = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const profile = deliveryProfile(task);
    if (!profile || task?.status !== "queued" || !task.delivery?.token) continue;
    const configuredMaxAttempts = options.maxAttemptsByType?.[task.type] ?? options.maxAttempts ?? 5;
    const maxAttempts = Math.max(1, Number(configuredMaxAttempts || 5));
    if (deliveryTime(task.delivery.expiresAt) > nowMs) continue;
    const attempt = Math.max(1, Number(task.delivery.attempt || 1));
    const changedAt = new Date(nowMs).toISOString();
    if (attempt >= maxAttempts) {
      task.status = "failed";
      task.completedAt = changedAt;
      task.result = {
        ...(task.result || {}),
        error: profile.failedError,
        message: profile.failedMessage(attempt)
      };
      if (!Array.isArray(task.events)) task.events = [];
      task.events.push({
        eventId: `gallery-delivery-${nowMs}-${attempt}`,
        phase: "delivery_failed",
        level: "error",
        message: task.type === "xhs_publish" ? "发布任务交付失败" : "图片任务交付失败",
        detail: { attempt },
        createdAt: changedAt
      });
    } else {
      if (!Array.isArray(task.events)) task.events = [];
      task.events.push({
        eventId: `gallery-delivery-${nowMs}-${attempt}`,
        phase: "delivery_retry",
        level: "warn",
        message: task.type === "xhs_publish" ? "发布任务未确认接收，已重新排队" : "图片任务未确认接收，已重新排队",
        detail: { attempt, nextAttempt: attempt + 1 },
        createdAt: changedAt
      });
    }
    delete task.delivery;
    task.updatedAt = changedAt;
    changedTasks.push(task);
  }
  return { changed: changedTasks.length > 0, tasks: changedTasks };
}
