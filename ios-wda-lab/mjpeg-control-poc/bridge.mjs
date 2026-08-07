const MAX_TEXT_LENGTH = 512;

export const DEFAULT_SESSION_SETTINGS = Object.freeze({
  mjpegServerFramerate: 45,
  mjpegServerScreenshotQuality: 60,
  mjpegScalingFactor: 100,
  waitForIdleTimeout: 0.5,
});

export function createMjpegMetrics(windowMs = 5_000) {
  const frameTimes = [];
  return {
    clients: 0,
    frames: 0,
    latestFrameAt: 0,
    recordFrame(timestamp = Date.now()) {
      this.frames += 1;
      this.latestFrameAt = timestamp;
      frameTimes.push(timestamp);
      this.prune(timestamp);
    },
    fpsAt(timestamp = Date.now()) {
      this.prune(timestamp);
      return frameTimes.length * 1_000 / windowMs;
    },
    prune(timestamp) {
      const oldestAllowed = timestamp - windowMs;
      while (frameTimes.length && frameTimes[0] < oldestAllowed) frameTimes.shift();
    },
  };
}

export function mapPointToDevice({ clientX, clientY, rect, deviceSize }) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !rect || !deviceSize || rect.width <= 0 || rect.height <= 0) {
    throw new Error("invalid_point");
  }

  const x = Math.round(((clientX - rect.left) / rect.width) * deviceSize.width);
  const y = Math.round(((clientY - rect.top) / rect.height) * deviceSize.height);
  return {
    x: clamp(x, 0, Math.max(0, deviceSize.width - 1)),
    y: clamp(y, 0, Math.max(0, deviceSize.height - 1)),
  };
}

export function parseControlPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("invalid_payload");
  if (payload.type === "text") {
    if (typeof payload.text !== "string" || !payload.text.length || payload.text.length > MAX_TEXT_LENGTH) {
      throw new Error("invalid_text");
    }
    return { type: "text", text: payload.text };
  }
  if (payload.type === "tap") return { type: "tap", point: parsePoint(payload.point) };
  if (payload.type === "swipe") {
    const duration = Number(payload.durationMs);
    if (!Number.isFinite(duration) || duration < 80 || duration > 1_500) throw new Error("invalid_swipe_duration");
    return {
      type: "swipe",
      start: parsePoint(payload.start),
      end: parsePoint(payload.end),
      durationMs: Math.round(duration),
    };
  }
  throw new Error("invalid_control_type");
}

export function clampPoint(point, size) {
  return {
    x: clamp(Math.round(point.x), 0, Math.max(0, size.width - 1)),
    y: clamp(Math.round(point.y), 0, Math.max(0, size.height - 1)),
  };
}

function parsePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("invalid_point");
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
