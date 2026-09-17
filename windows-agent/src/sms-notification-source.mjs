import { createHash } from "node:crypto";

const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const TEXT_EXTRA_RE = /^\s*(android\.(?:text|bigText|title|subText|summaryText|infoText))\s*=\s*(?:String\s*)?\((.*)\)\s*$/;

export function normalizeDefaultSmsPackage(value) {
  const packageName = String(value || "").trim().split(/[\s/]/, 1)[0];
  return PACKAGE_NAME_RE.test(packageName) ? packageName : "";
}

export function parseDefaultSmsRoleHolders(output) {
  const text = String(output || "");
  const smsRole = text.match(/\{\s*name=android\.app\.role\.SMS\b([\s\S]*?)\}/);
  if (smsRole) {
    const packageName = normalizeDefaultSmsPackage(smsRole[1].match(/\bholders=([^\s,}]+)/)?.[1]);
    if (packageName) return packageName;
  }
  if (/\bROLE STATE\b|\bname=android\.app\.role\./.test(text)) return "";
  for (const line of text.split(/\r?\n/)) {
    const packageName = normalizeDefaultSmsPackage(line);
    if (packageName) return packageName;
  }
  return "";
}

export function parseLegacyDefaultSmsPackage(output) {
  const value = String(output || "").trim();
  if (!value || value === "null" || value === "undefined") return "";
  return normalizeDefaultSmsPackage(value);
}

export function parseResolvedDefaultSmsPackage(output) {
  for (const line of String(output || "").split(/\r?\n/).reverse()) {
    const packageName = normalizeDefaultSmsPackage(line);
    if (packageName) return packageName;
  }
  return "";
}

export function buildSmsRoleHolderArgs() {
  return ["shell", "dumpsys", "role"];
}

export function buildLegacyDefaultSmsPackageArgs() {
  return ["shell", "settings", "get", "secure", "sms_default_application"];
}

export function buildDefaultSmsSendToResolveArgs() {
  return [
    "shell", "cmd", "package", "resolve-activity", "--brief",
    "-a", "android.intent.action.SENDTO", "-d", "smsto:10086"
  ];
}

export function buildSmsNotificationDumpArgs(packageName) {
  const safePackage = normalizeDefaultSmsPackage(packageName);
  if (!safePackage || safePackage !== String(packageName || "").trim()) {
    throw new Error("invalid_default_sms_package");
  }
  return ["shell", "dumpsys", "notification", "--noredact", "--package", safePackage];
}

export function buildSmsRelatedPackageListArgs(packageName) {
  const safePackage = normalizeDefaultSmsPackage(packageName);
  if (!safePackage || safePackage !== String(packageName || "").trim()) {
    throw new Error("invalid_default_sms_package");
  }
  return ["shell", "pm", "list", "packages", safePackage];
}

export function buildSmsPackageDumpArgs(packageName) {
  const safePackage = normalizeDefaultSmsPackage(packageName);
  if (!safePackage || safePackage !== String(packageName || "").trim()) {
    throw new Error("invalid_sms_package");
  }
  return ["shell", "dumpsys", "package", safePackage];
}

export function parseInstalledPackageNames(output) {
  return unique([...String(output || "").matchAll(/^package:([^\s]+)(?:\s|$)/gm)]
    .map((match) => normalizeDefaultSmsPackage(match[1])));
}

export function parseSmsPackageTrustEvidence(output) {
  const text = String(output || "");
  const signature = String(text.match(/signatures=PackageSignatures\{[^\r\n]*?signatures:\[([^\]]+)\]/)?.[1] || "").trim();
  return {
    signature,
    system: /pkgFlags=\[[^\]]*\bSYSTEM\b/.test(text),
    privileged: /privatePkgFlags=\[[^\]]*\bPRIVILEGED\b/.test(text)
  };
}

export function selectTrustedSmsNotificationPackages(defaultPackage, installedPackages, evidenceByPackage = {}) {
  const safeDefault = normalizeDefaultSmsPackage(defaultPackage);
  if (!safeDefault) return [];
  const evidence = evidenceByPackage instanceof Map
    ? evidenceByPackage
    : new Map(Object.entries(evidenceByPackage || {}));
  const primary = evidence.get(safeDefault) || {};
  const trusted = [safeDefault];
  for (const candidate of unique(Array.isArray(installedPackages) ? installedPackages : [])) {
    const safeCandidate = normalizeDefaultSmsPackage(candidate);
    if (!safeCandidate || safeCandidate === safeDefault || !safeCandidate.startsWith(`${safeDefault}.`)) continue;
    const candidateEvidence = evidence.get(safeCandidate) || {};
    const sameSignature = Boolean(primary.signature && candidateEvidence.signature === primary.signature);
    if (sameSignature && (candidateEvidence.system || candidateEvidence.privileged)) trusted.push(safeCandidate);
  }
  return unique(trusted);
}

export function selectUnsentSmsNotifications(messages, uploadedKeys, { forceFull = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (forceFull) return [...list];
  const known = uploadedKeys instanceof Set ? uploadedKeys : new Set();
  return list.filter((message) => {
    const key = String(message?.messageKey || "").trim();
    return !key || !known.has(key);
  });
}

function hash(value, length = 40) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, length);
}

function notificationBlocks(output) {
  const text = String(output || "");
  const starts = [...text.matchAll(/^\s*NotificationRecord\(/gm)].map((match) => match.index);
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

function parseTextExtras(block) {
  const extras = new Map();
  for (const line of String(block || "").split(/\r?\n/)) {
    const match = line.match(TEXT_EXTRA_RE);
    if (!match) continue;
    const value = match[2].trim();
    if (value && value !== "null") extras.set(match[1], value);
  }
  return extras;
}

function parseAndroidMessages(block) {
  const values = [];
  for (const match of String(block || "").matchAll(/(?:^|[,\s{])(?:text|message)\s*=\s*(?:String\s*)?\(([^\r\n)]*)\)/gim)) {
    const value = String(match[1] || "").trim();
    if (value && value !== "null") values.push(value);
  }
  return values;
}

function firstFiniteTimestamp(block, fallbackMs) {
  for (const pattern of [
    /\bmUpdateTimeMs=(\d{10,13})\b/,
    /\bmCreationTimeMs=(\d{10,13})\b/,
    /\bpostTime=(\d{10,13})\b/,
    /\bwhen=(\d{10,13})\b/
  ]) {
    const value = Number(String(block || "").match(pattern)?.[1] || 0);
    if (Number.isFinite(value) && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  }
  return Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : Date.now();
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function isMaskedVerificationNotification(body) {
  const text = String(body || "").normalize("NFKC");
  if (!/(?:验证码|驗證碼|校验码|動態碼|动态码|verification\s*code|\botp\b)/i.test(text)) return false;
  if (!/(?:\*|•|●|·){4,8}/u.test(text)) return false;
  return !/(?<!\d)\d{4,8}(?!\d)/.test(text);
}

export function parseSmsNotificationDump(output, { packageName, packageNames, nowMs = Date.now(), maxAgeMs = 24 * 60 * 60_000 } = {}) {
  const safePackage = normalizeDefaultSmsPackage(packageName);
  if (!safePackage) throw new Error("invalid_default_sms_package");
  const allowedPackages = new Set(unique([safePackage, ...(Array.isArray(packageNames) ? packageNames : [])]
    .map((value) => normalizeDefaultSmsPackage(value))));
  const messages = [];
  const seen = new Set();
  for (const block of notificationBlocks(output)) {
    const recordPackage = normalizeDefaultSmsPackage(block.match(/\bpkg=([^\s,)]+)/)?.[1]);
    if (!allowedPackages.has(recordPackage)) continue;
    const extras = parseTextExtras(block);
    const messageBodies = parseAndroidMessages(block);
    const bodyCandidates = messageBodies.length
      ? unique(messageBodies)
      : unique([extras.get("android.bigText") || extras.get("android.text")]);
    const title = String(extras.get("android.title") || "").trim();
    const timestampMs = firstFiniteTimestamp(block, nowMs);
    if (timestampMs > nowMs + 5 * 60_000 || nowMs - timestampMs > maxAgeMs) continue;
    const notificationKey = String(block.match(/\bkey=([^\s,)]+)/)?.[1] || "").trim();
    for (const body of bodyCandidates) {
      if (!body || body === title) continue;
      // Some OEM SMS apps redact OTP digits in the notification snapshot even
      // when content://sms contains the complete message. Asterisks cannot be
      // reversed safely, so never upload this unusable copy. The Provider row
      // remains the authority; server-side reconciliation also hides historic
      // masked copies when one unique full row can be proven.
      if (isMaskedVerificationNotification(body)) continue;
      // A notification dump is stable until Android updates that notification,
      // so the record timestamp and notification key keep repeated polls
      // idempotent while preserving two identical SMS messages received close
      // together.
      const semantic = `${recordPackage}\n${notificationKey}\n${title}\n${body}\n${timestampMs}`;
      const localKey = hash(semantic);
      if (seen.has(localKey)) continue;
      seen.add(localKey);
      messages.push({
        messageKey: `notification:${localKey}`,
        box: "inbox",
        type: 1,
        address: title,
        body,
        messageAt: new Date(timestampMs).toISOString(),
        receivedAt: new Date(timestampMs).toISOString(),
        subscriptionId: null,
        slotIndex: null,
        source: "windows-agent-notification",
        sourcePackage: recordPackage,
        sourceNotificationKey: notificationKey ? hash(notificationKey, 24) : ""
      });
    }
  }
  return messages;
}
