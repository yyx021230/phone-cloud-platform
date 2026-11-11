import { listDailyBatches, readDailyBatch } from "./admin-history.mjs";

const webhookPattern = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const noticeKey = runId => `notice/xhs-logged-out/${runId}`;
const label = value => String(value ?? "").replace(/[\p{Cc}<>&]/gu, " ").trim().slice(0, 80);

export function parseLoginNotificationConfig(input) {
  const { webhookUrl, clientId, from } = input ?? {};
  if (typeof webhookUrl !== "string" || webhookUrl.trim() !== webhookUrl || !webhookPattern.test(webhookUrl)
      || typeof clientId !== "string" || !clientId.trim()
      || typeof from !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(from) || !Number.isFinite(Date.parse(from))) {
    throw new Error("invalid_xhs_login_feishu_config");
  }
  return { webhookUrl, clientId, from: new Date(from).toISOString() };
}

export function createFeishuLoginSender(config, fetchImpl = fetch) {
  return {
    async send(text) {
      const body = JSON.stringify({ msg_type: "text", content: { text } });
      if (Buffer.byteLength(body) > 20_000) return { status: "failed", reason: "webhook_payload_too_large" };
      const response = await fetchImpl(config.webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body, redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (response.status >= 500 || response.status === 408) return { status: "delivery_unknown" };
      const result = await response.json();
      if (response.ok && result?.code === 0) return { status: "sent" };
      if (Number.isInteger(result?.code) && result.code !== 0) return { status: "failed", errorCode: result.code };
      return { status: "delivery_unknown" };
    },
  };
}

export async function notifyDailyLogouts(db, config, sender, clock = Date.now) {
  // Retain two days of recovery time for the notifier without sending old backlogs.
  const from = new Date(Math.max(Date.parse(config.from), clock() - 48 * 3600_000)).toISOString();
  const { batches } = await listDailyBatches(db, { clientId: config.clientId, from });
  for (const run of batches.reverse()) {
    if (run.status !== "completed") continue;
    const key = noticeKey(run.runId);
    if ((await db.query("select 1 from phone_cloud_xhs_batch_records where record_key = $1", [key])).rowCount) continue;
    const batch = await readDailyBatch(db, run.runId, { clientId: config.clientId });
    if (batch?.status !== "completed") continue;
    const slots = batch.items.filter(item => item.status === "failed" && item.reason === "confirmed_logged_out");
    if (!slots.length) continue;
    const lines = slots.map(item => {
      const slot = { app1: "主 App", app2: "副 App" }[item.appSlot] || "槽位待核对";
      return `${label(item.deviceName) || "编号未记录"}号手机（${slot}）：小红书账号「${label(item.accountName) || "账号名称未记录"}」掉线。`;
    });
    const text = lines.join("\n");
    // Webhooks do not return a message ID. Claim before posting and never
    // replay if the send outcome is ambiguous.
    const claim = { runId: run.runId, at: new Date(clock()).toISOString(), count: slots.length, status: "claimed" };
    const inserted = await db.query(`
      insert into phone_cloud_xhs_batch_records(record_key, data) values ($1, $2::jsonb)
      on conflict (record_key) do nothing`, [key, JSON.stringify(claim)]);
    if (inserted.rowCount !== 1) continue;
    let outcome;
    try { outcome = await sender.send(text); }
    catch { outcome = { status: "delivery_unknown" }; }
    await db.query("update phone_cloud_xhs_batch_records set data = $2::jsonb, updated_at = now() where record_key = $1",
      [key, JSON.stringify({ ...claim, ...outcome, finishedAt: new Date(clock()).toISOString() })]);
  }
}
