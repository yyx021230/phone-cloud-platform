import crypto from "node:crypto";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{3,80}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export function parseOpenNameLookupClients(value = "") {
  if (!String(value || "").trim()) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return new Map();
  }
  const clients = new Map();
  const usernames = new Set();
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const clientId = String(item?.clientId || "").trim();
    const secret = String(item?.secret || "").trim();
    const username = String(item?.username || "").trim().toLowerCase();
    const deviceIds = [...new Set((Array.isArray(item?.deviceIds) ? item.deviceIds : [])
      .map((deviceId) => String(deviceId || "").trim())
      .filter(Boolean))];
    if (!CLIENT_ID_PATTERN.test(clientId) || clients.has(clientId) || secret.length < 32 || !username || !deviceIds.length || usernames.has(username)) continue;
    clients.set(clientId, {
      clientId,
      secret,
      username,
      deviceIds
    });
    usernames.add(username);
  }
  return clients;
}

export function normalizeExternalReference(value, field = "reference") {
  const text = String(value || "").trim();
  if (!REFERENCE_PATTERN.test(text)) throw new TypeError(`invalid_${field}`);
  return text;
}

export function openLookupRequestFingerprint(input = {}) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function isOpenLookupDeviceAllowed(client, deviceId) {
  return Boolean(client && client.deviceIds.includes(String(deviceId || "").trim()));
}

export function publicOpenLookupSession(session = {}) {
  const allResults = Array.isArray(session.results) ? session.results : [];
  const results = allResults.slice(0, 500).map(publicOpenLookupResult);
  const humanSource = allResults.find((result) => result?.status === "needs_human_verification") || null;
  const humanResult = humanSource ? publicOpenLookupResult(humanSource) : null;
  const jigsawRequired = (session.limitReason === "jigsaw_verification" && session.requiresAccountSwitch !== true)
    || session.status === "needs_human_verification"
    || Boolean(humanResult);
  const automaticAccountRotationExhausted = session.requiresAccountSwitch === true
    && !session.pendingJobId;
  return {
    sessionId: String(session.sessionId || ""),
    deviceId: String(session.deviceId || ""),
    status: String(session.status || "starting"),
    pending: Boolean(session.pendingJobId),
    queuedCount: Math.max(0, Number(session.queuedCount || 0)),
    resultCount: allResults.length,
    resultsTruncated: allResults.length > results.length,
    successfulCount: Math.max(0, Number(session.successfulCount || 0)),
    currentAccount: String(session.currentAccount || ""),
    results,
    queueState: automaticAccountRotationExhausted ? {
      status: "paused",
      reason: String(session.automationHaltReason || session.limitReason || "automatic_account_rotation_exhausted"),
      action: "end_session_and_select_another_device"
    } : { status: session.pendingJobId ? "running" : session.queuedCount ? "waiting" : "idle" },
    humanAction: jigsawRequired ? {
      required: true,
      type: "manual_jigsaw_verification",
      reason: String(humanResult?.reason || session.limitReason || "human_verification_required"),
      queryId: String(humanResult?.queryId || ""),
      resumeAllowed: Boolean(humanResult?.queryId && !session.pendingJobId)
    } : { required: false },
    error: String(session.error || ""),
    createdAt: String(session.createdAt || ""),
    updatedAt: String(session.updatedAt || ""),
    endedAt: session.endedAt || null
  };
}

export function publicOpenLookupResult(result = {}) {
  return {
    queryId: String(result?.resultId || ""),
    clientReference: String(result?.clientReference || ""),
    queuePosition: Number(result?.queuePosition) > 0 ? Number(result.queuePosition) : null,
    phoneNumber: maskPhone(result?.phoneNumber),
    status: String(result?.status || "queued"),
    stage: String(result?.stage || ""),
    maskedName: String(result?.name || result?.maskedName || ""),
    nameTailCharacter: String(result?.realNameTailCharacter || ""),
    accountSwitched: Boolean(result?.accountSwitched),
    accountSwitchReason: String(result?.accountSwitchReason || ""),
    accountSwitchCount: Math.max(0, Number(result?.accountSwitchCount || 0)),
    reason: String(result?.limitReason || result?.errorCode || ""),
    error: String(result?.error || ""),
    createdAt: String(result?.createdAt || ""),
    updatedAt: String(result?.updatedAt || "")
  };
}

function maskPhone(value = "") {
  const phone = String(value || "").replace(/\D/g, "");
  if (phone.length < 7) return "";
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
