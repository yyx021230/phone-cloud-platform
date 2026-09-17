import crypto from "node:crypto";

const ACTIVE_STATUSES = new Set(["connecting", "ready", "streaming"]);

export class ScreenSessionRegistry {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = Math.max(30_000, Number(options.ttlMs || 10 * 60_000));
    this.mediaPaths = Array.isArray(options.mediaPaths)
      ? options.mediaPaths.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    this.sessions = new Map();
    this.activeByDevice = new Map();
  }

  create(input) {
    this.expire();
    const deviceId = required(input.deviceId, "deviceId");
    const activeId = this.activeByDevice.get(deviceId);
    const active = activeId ? this.sessions.get(activeId) : null;
    if (active && ACTIVE_STATUSES.has(active.status)) {
      const error = new Error("device_screen_busy");
      error.code = "device_screen_busy";
      error.session = this.public(active);
      throw error;
    }

    const mediaPath = this.nextMediaPath();
    if (this.mediaPaths.length && !mediaPath) {
      const error = new Error("screen_media_capacity_exhausted");
      error.code = "screen_media_capacity_exhausted";
      throw error;
    }

    const now = this.now();
    const browserToken = `pcs_${crypto.randomBytes(32).toString("base64url")}`;
    const session = {
      sessionId: crypto.randomUUID(),
      deviceId,
      agentId: required(input.agentId, "agentId"),
      adbSerial: required(input.adbSerial, "adbSerial"),
      userId: required(input.userId, "userId"),
      status: "connecting",
      statusMessage: "正在连接 Windows 管理器",
      browserTokenHash: hash(browserToken),
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.ttlMs,
      metadata: {},
      transportMode: "multiplexed",
      requestedQualityProfile: String(input.requestedQualityProfile || "auto"),
      mediaPath,
      mediaTransport: ["webrtc", "direct_webrtc"].includes(String(input.mediaTransport || ""))
        ? String(input.mediaTransport)
        : "websocket",
      qualityProfile: "",
      browserConnected: false,
      agentConnected: false
    };
    this.sessions.set(session.sessionId, session);
    this.activeByDevice.set(deviceId, session.sessionId);
    return { session: this.public(session), browserToken };
  }

  get(sessionId) {
    const session = this.sessions.get(String(sessionId || ""));
    return session ? this.public(session) : null;
  }

  getMutable(sessionId) {
    return this.sessions.get(String(sessionId || "")) || null;
  }

  activeForDevice(deviceId) {
    const sessionId = this.activeByDevice.get(String(deviceId || ""));
    const session = sessionId ? this.sessions.get(sessionId) : null;
    return session && ACTIVE_STATUSES.has(session.status) ? this.public(session) : null;
  }

  activeCount() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (ACTIVE_STATUSES.has(session.status)) count += 1;
    }
    return count;
  }

  nextMediaPath() {
    if (!this.mediaPaths.length) return "";
    const claimed = new Set();
    for (const session of this.sessions.values()) {
      if (ACTIVE_STATUSES.has(session.status) && session.mediaPath) claimed.add(session.mediaPath);
    }
    return this.mediaPaths.find((path) => !claimed.has(path)) || "";
  }

  authorizeBrowser(sessionId, token, userId = "") {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session || !ACTIVE_STATUSES.has(session.status)) return { ok: false };
    if (userId && session.userId !== String(userId)) return { ok: false };
    const supplied = hash(String(token || ""));
    const expected = Buffer.from(session.browserTokenHash, "hex");
    const actual = Buffer.from(supplied, "hex");
    return { ok: expected.length === actual.length && crypto.timingSafeEqual(expected, actual), session };
  }

  canAccess(session, ctx) {
    if (!session || !ctx) return false;
    return ctx.role === "admin" || (ctx.role === "user" && session.userId === ctx.userId);
  }

  update(sessionId, patch = {}) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) return null;
    if (patch.status && !["connecting", "ready", "streaming", "closed", "failed", "expired"].includes(patch.status)) {
      throw new Error("invalid_screen_session_status");
    }
    Object.assign(session, patch, { updatedAtMs: this.now() });
    if (!ACTIVE_STATUSES.has(session.status)) this.releaseDeviceIndex(session);
    return this.public(session);
  }

  close(sessionId, status = "closed", statusMessage = "投屏已结束") {
    return this.update(sessionId, { status, statusMessage, browserConnected: false, agentConnected: false });
  }

  expire() {
    const now = this.now();
    const expired = [];
    for (const session of this.sessions.values()) {
      if (!ACTIVE_STATUSES.has(session.status) || session.expiresAtMs > now) continue;
      session.status = "expired";
      session.statusMessage = "投屏会话已超时";
      session.updatedAtMs = now;
      this.releaseDeviceIndex(session);
      expired.push(this.public(session));
    }
    return expired;
  }

  public(session) {
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      agentId: session.agentId,
      adbSerial: session.adbSerial,
      userId: session.userId,
      status: session.status,
      statusMessage: session.statusMessage,
      browserConnected: Boolean(session.browserConnected),
      agentConnected: Boolean(session.agentConnected),
      metadata: session.metadata || {},
      transportMode: session.transportMode || "multiplexed",
      mediaTransport: session.mediaTransport || "websocket",
      mediaPath: session.mediaPath || "",
      // Relay startup receives the public session projection. Preserve the
      // caller's requested profile so it cannot silently fall back to auto.
      requestedQualityProfile: session.requestedQualityProfile || "auto",
      qualityProfile: session.qualityProfile || "",
      createdAt: new Date(session.createdAtMs).toISOString(),
      updatedAt: new Date(session.updatedAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString()
    };
  }

  releaseDeviceIndex(session) {
    if (this.activeByDevice.get(session.deviceId) === session.sessionId) this.activeByDevice.delete(session.deviceId);
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}
