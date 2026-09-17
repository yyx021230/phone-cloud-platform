import crypto from "node:crypto";

export function createScreenTurnIceServers({
  staticIceServers = [],
  turnUrls = [],
  sharedSecret = "",
  sessionId = "",
  ttlSeconds = 600,
  nowMs = Date.now()
} = {}) {
  const normalizedStatic = normalizeIceServers(staticIceServers);
  const urls = normalizeUrls(turnUrls);
  const secret = String(sharedSecret || "");
  if (!urls.length || !secret) return normalizedStatic;

  const ttl = Math.max(60, Math.min(3_600, Math.round(Number(ttlSeconds) || 600)));
  const expiresAtSeconds = Math.floor(Number(nowMs || Date.now()) / 1_000) + ttl;
  const subject = String(sessionId || "screen").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "screen";
  const username = `${expiresAtSeconds}:${subject}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return [
    { urls, username, credential },
    ...normalizedStatic
  ].slice(0, 8);
}

export function parseScreenTurnUrls(value) {
  return normalizeUrls(String(value || "").split(","));
}

function normalizeIceServers(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 8).map((item) => {
    const urls = normalizeUrls(Array.isArray(item?.urls) ? item.urls : [item?.urls]);
    if (!urls.length) return null;
    return {
      urls: urls.length === 1 ? urls[0] : urls,
      ...(item?.username ? { username: String(item.username).slice(0, 256) } : {}),
      ...(item?.credential ? { credential: String(item.credential).slice(0, 512) } : {})
    };
  }).filter(Boolean);
}

function normalizeUrls(input) {
  return [...new Set((Array.isArray(input) ? input : [])
    .map((value) => String(value || "").trim())
    .filter((value) => /^(?:stun|turn|turns):/i.test(value))
  )].slice(0, 8);
}
