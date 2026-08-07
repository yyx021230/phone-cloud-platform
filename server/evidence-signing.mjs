import crypto from "node:crypto";

export function createEvidenceSignedUrl(evidenceId, options = {}) {
  const id = String(evidenceId || "");
  if (!id) return "";
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ttlSeconds = Math.max(1, Math.floor(Number(options.ttlSeconds) || 300));
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  const signature = signEvidence(id, expires, options.secret);
  return `/api/v1/evidence/${encodeURIComponent(id)}?expires=${expires}&sig=${signature}`;
}

export function verifyEvidenceSignedUrl(evidenceId, options = {}) {
  const id = String(evidenceId || "");
  const expires = Number(options.expires);
  const signature = String(options.signature || "");
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  if (!id || !Number.isInteger(expires) || expires <= Math.floor(nowMs / 1000) || !signature) return false;
  const expected = signEvidence(id, expires, options.secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signEvidence(evidenceId, expires, secret) {
  const key = String(secret || "");
  if (!key) return "";
  return crypto.createHmac("sha256", key)
    .update(`${evidenceId}.${expires}`)
    .digest("hex");
}
