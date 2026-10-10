import fs from "node:fs/promises";
import path from "node:path";
import { resumableLookupHumanVerificationResult } from "./automation-center.mjs";
import { lookupHumanChallenge } from "./lookup-human-handover.mjs";

export async function readLookupHumanWebhook(env = process.env) {
  if (env.LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE) {
    return (await fs.readFile(env.LOOKUP_HUMAN_FEISHU_WEBHOOK_FILE, "utf8")).trim();
  }
  return String(env.LOOKUP_HUMAN_FEISHU_WEBHOOK || "").trim();
}

export function lookupNotificationDeviceLabel(device = {}) {
  // Inventory numbers are administrator-facing device names, never model
  // digits, ADB serials, array positions, SIM numbers or an example number.
  const match = String(device.deviceName || "").trim().match(/^([1-9]\d{0,5})(?:\s*号.*|\s*手机)?$/u);
  return match ? `${match[1]}号手机` : "";
}

export function pendingLookupHumanNotifications(sessions = [], devices = []) {
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  return sessions.flatMap((session) => {
    const result = resumableLookupHumanVerificationResult(session);
    const device = byId.get(session.deviceId);
    const deviceName = lookupNotificationDeviceLabel(device);
    if (!session.sessionId || !result?.resultId || !deviceName
        || !(result.limitReason === "jigsaw_verification"
          || result.errorCode === "alipay_human_verification_required")) return [];
    return [{
      // Reuse the handover's stable challenge identity: a resumed query can
      // encounter another puzzle while retaining the same original result.
      key: lookupHumanChallenge(session),
      deviceName
    }];
  });
}

// A durable claim precedes the only HTTP attempt. Unknown delivery is never
// retried automatically: a bot webhook has no idempotency-key contract.
export function createLookupHumanNotifier({ webhookUrl = "", receiptsDir, getTargets,
  fetchImpl = fetch, now = () => new Date().toISOString(), onResult = () => {}, timeoutMs = 5000 }) {
  if (webhookUrl) {
    let url;
    try { url = new URL(webhookUrl); } catch { throw new Error("invalid_lookup_human_webhook"); }
    if (url.protocol !== "https:" || url.hostname !== "open.feishu.cn" || url.port
        || url.username || url.password || url.search || url.hash
        || !/^\/open-apis\/bot\/v2\/hook\/[a-z0-9-]+$/i.test(url.pathname)) {
      throw new Error("invalid_lookup_human_webhook");
    }
  }
  let running = null;
  const report = (receipt) => {
    try { onResult({ key: receipt.key, status: receipt.status,
      httpStatus: receipt.httpStatus, providerCode: receipt.providerCode }); } catch {}
  };
  async function pollOnce() {
    if (!webhookUrl) return [];
    const targets = getTargets();
    if (!targets.length) return [];
    await fs.mkdir(receiptsDir, { recursive: true, mode: 0o700 });
    const outcomes = [];
    for (const target of targets) {
      if (!/^[a-f0-9]{64}$/.test(target.key)) throw new Error("invalid_lookup_human_notification_key");
      const receiptPath = path.join(receiptsDir, `${target.key}.json`);
      let handle;
      try { handle = await fs.open(receiptPath, "wx", 0o600); }
      catch (error) { if (error.code === "EEXIST") continue; throw new Error("lookup_human_receipt_unavailable"); }
      const receipt = { key: target.key, status: "sending", attemptedAt: now() };
      try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
      finally { await handle.close(); }
      if (!getTargets().some((item) => item.key === target.key)) {
        receipt.status = "cancelled";
      } else {
        try {
          const response = await fetchImpl(webhookUrl, {
            method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({ msg_type: "text", content: {
              text: `${target.deviceName}出现拼图，请人工介入到云手机平台实时控制完成拼图。`
            } })
          });
          receipt.httpStatus = response.status;
          if (!response.ok) receipt.status = "rejected";
          else {
            const body = await response.json();
            const code = body.code === undefined ? body.StatusCode : body.code;
            if (typeof code === "number") receipt.providerCode = code;
            receipt.status = code === 0 ? "sent" : typeof code === "number" ? "rejected" : "unknown";
          }
        } catch { receipt.status = "unknown"; }
      }
      receipt.updatedAt = now();
      // If recording the response fails, the original claim still prevents a
      // restart from duplicating a message already accepted by Feishu.
      await fs.writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      report(receipt);
      outcomes.push(receipt);
    }
    return outcomes;
  }
  return {
    poll() {
      if (!running) running = pollOnce().finally(() => { running = null; });
      return running;
    }
  };
}
