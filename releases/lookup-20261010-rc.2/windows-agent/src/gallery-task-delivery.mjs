export const SCREEN_GALLERY_DELIVERY_PROTOCOL = "gallery_v2";
export const XHS_PUBLISH_DELIVERY_PROTOCOL = "xhs_publish_v1";

function wait(ms, timers = { setTimeout }) {
  return new Promise((resolve) => timers.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function retry(operation, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(Number(options.retryDelayMs || 250) * attempt, options.timers);
    }
  }
  throw lastError || new Error("screen_gallery_delivery_failed");
}

function normalizePublishImageDataUrls(payload = {}) {
  const source = payload?.imageDataUrls;
  const values = Array.isArray(source)
    ? source
    : source && typeof source === "object"
      ? Object.keys(source)
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => source[key])
      : payload?.imageDataUrl
        ? [payload.imageDataUrl]
        : [];
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export async function hydrateLeasedWindowsTask(task, options = {}) {
  const isGallery = task?.type === "screen_gallery_import";
  const isPublish = task?.type === "xhs_publish";
  if (!isGallery && !isPublish) return { task, acknowledged: true, legacy: false };
  if ((isGallery && task.payload?.imageDataUrl) || (isPublish && task.payload?.imageDataUrls?.length)) {
    return { task, acknowledged: true, legacy: true };
  }
  const deliveryToken = String(task.deliveryToken || "");
  if (!deliveryToken) throw new Error("screen_gallery_delivery_token_missing");
  const request = options.request;
  if (typeof request !== "function") throw new Error("screen_gallery_delivery_request_missing");
  const encodedTaskId = encodeURIComponent(String(task.taskId || ""));
  const payloadResponse = await retry(() => request(`/api/v1/windows-agent-tasks/${encodedTaskId}/payload`, {
    method: "POST",
    // Publish images can legitimately be several megabytes each. Eight
    // seconds was shorter than a real 3.3 MB response on the production path,
    // so fetch aborted while response.json() was still reading the body.
    timeoutMs: Number(options.payloadTimeoutMs || (isPublish ? 45_000 : 15_000)),
    body: { deliveryToken }
  }), {
    attempts: options.payloadAttempts || 3,
    retryDelayMs: options.retryDelayMs || 250,
    timers: options.timers
  });
  const hydratedPayload = { ...(payloadResponse?.payload || {}) };
  if (isGallery) {
    const imageDataUrl = String(hydratedPayload.imageDataUrl || "");
    if (!imageDataUrl.startsWith("data:image/")) throw new Error("screen_gallery_delivery_payload_invalid");
  } else {
    const imageDataUrls = normalizePublishImageDataUrls(hydratedPayload);
    if (!imageDataUrls.length) {
      const source = hydratedPayload?.imageDataUrls;
      const sourceType = Array.isArray(source) ? "array" : source === null ? "null" : typeof source;
      throw new Error(`xhs_publish_delivery_payload_invalid:type=${sourceType}:keys=${Object.keys(hydratedPayload).join(",")}`);
    }
    // The publish runner already performs the authoritative MIME, base64 and
    // magic-byte validation before touching the phone.  The delivery layer is
    // intentionally limited to shape normalization so large valid payloads do
    // not get rejected here because an older server serialized their array as
    // a numeric-key object or used the legacy single-image field.
    hydratedPayload.imageDataUrls = imageDataUrls;
    delete hydratedPayload.imageDataUrl;
  }
  const hydratedTask = {
    ...task,
    payload: { ...(task.payload || {}), ...hydratedPayload }
  };
  let acknowledgementError = null;
  try {
    await retry(() => request(`/api/v1/windows-agent-tasks/${encodedTaskId}/ack`, {
      method: "POST",
      timeoutMs: Number(options.ackTimeoutMs || 5_000),
      body: { deliveryToken }
    }), {
      attempts: options.ackAttempts || 3,
      retryDelayMs: options.retryDelayMs || 250,
      timers: options.timers
    });
  } catch (error) {
    // The acknowledgement request can be committed server-side while its
    // response is lost. The caller decides whether the hydrated task is safe
    // to execute: gallery import is idempotent enough to continue, while an
    // external publish must fail closed to avoid a duplicate side effect.
    acknowledgementError = error;
  }
  return {
    task: hydratedTask,
    acknowledged: !acknowledgementError,
    acknowledgementError,
    legacy: false
  };
}

export async function hydrateScreenGalleryTask(task, options = {}) {
  return hydrateLeasedWindowsTask(task, options);
}
