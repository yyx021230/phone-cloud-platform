import crypto from "node:crypto";

const TOKEN_PREFIX = "pcmt";
const ACTIONS = new Set(["publish", "read"]);

export function createScreenMediaAuthorizer({ secret, now = Date.now, tokenTtlMs = 10 * 60_000 } = {}) {
  const signingSecret = Buffer.from(String(secret || ""), "utf8");
  if (signingSecret.byteLength < 16) throw new Error("screen_media_auth_secret_too_short");
  const ttlMs = Math.max(60_000, Number(tokenTtlMs || 0));

  const issue = ({ sessionId, action, path = "" }) => {
    const normalizedAction = normalizeAction(action);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedPath = normalizePath(path || mediaPathForSession(normalizedSessionId));
    const payload = {
      v: 1,
      sid: normalizedSessionId,
      act: normalizedAction,
      path: normalizedPath,
      exp: Number(now()) + ttlMs,
      nonce: crypto.randomBytes(12).toString("base64url")
    };
    return `${TOKEN_PREFIX}.${base64url(JSON.stringify(payload))}.${sign(payload, signingSecret)}`;
  };

  const verify = (token, { action, path } = {}) => {
    const parsed = parseToken(token);
    if (!parsed) return { ok: false, reason: "invalid_token" };
    const expected = sign(parsed.payload, signingSecret);
    if (!safeEqual(parsed.signature, expected)) return { ok: false, reason: "invalid_signature" };
    if (Number(parsed.payload.exp || 0) < Number(now())) return { ok: false, reason: "expired_token" };
    if (action && parsed.payload.act !== normalizeAction(action)) return { ok: false, reason: "invalid_action" };
    if (path && parsed.payload.path !== normalizePath(path)) return { ok: false, reason: "invalid_path" };
    return { ok: true, payload: parsed.payload };
  };

  const authorizeMediaRequest = (input = {}) => {
    const action = String(input.action || "").trim();
    const path = String(input.path || "").trim();
    const token = extractMediaToken(input);
    if (!ACTIONS.has(action) || !path || !token) return { ok: false, reason: "missing_media_credentials" };
    return verify(token, { action, path });
  };

  return { issue, verify, authorizeMediaRequest };
}

export function mediaPathForSession(sessionOrId) {
  if (sessionOrId && typeof sessionOrId === "object" && sessionOrId.mediaPath) {
    return normalizePath(sessionOrId.mediaPath);
  }
  return `pc/${normalizeSessionId(sessionOrId)}`;
}

export function extractMediaToken(input = {}) {
  const direct = String(input.token || "").trim();
  if (direct) return stripBearer(direct);
  const authorization = String(input.authorization || input.Authorization || "").trim();
  if (authorization) return stripBearer(authorization);
  const query = new URLSearchParams(String(input.query || ""));
  return String(query.get("token") || "").trim();
}

function normalizeAction(value) {
  const action = String(value || "").trim();
  if (!ACTIONS.has(action)) throw new Error("invalid_screen_media_action");
  return action;
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(sessionId)) throw new Error("invalid_screen_media_session");
  return sessionId;
}

function normalizePath(value) {
  const path = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^pc\/(?:slot-[1-9][0-9]*|[a-zA-Z0-9-]{16,80})$/.test(path)) throw new Error("invalid_screen_media_path");
  return path;
}

function parseToken(value) {
  const [prefix, encoded, signature, extra] = String(value || "").split(".");
  if (prefix !== TOKEN_PREFIX || !encoded || !signature || extra) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (Number(payload?.v) !== 1 || !ACTIONS.has(payload?.act)) return null;
    normalizeSessionId(payload.sid);
    normalizePath(payload.path);
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= 0) return null;
    return { payload, signature };
  } catch {
    return null;
  }
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(base64url(JSON.stringify(payload))).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

function base64url(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function stripBearer(value) {
  return String(value || "").replace(/^Bearer\s+/i, "").trim();
}
