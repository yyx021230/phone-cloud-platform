// Optional separate worker. It does not create a scheduler lease or load the platform .env.
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createFeishuLoginSender, notifyDailyLogouts, parseLoginNotificationConfig } from "./feishu-login-notifier.mjs";

const file = process.env.XHS_LOGIN_FEISHU_CONFIG_FILE;
if (!file || !process.env.XHS_BATCH_DATABASE_URL) throw new Error("xhs_login_feishu_config_required");
const stat = await fs.stat(file);
if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) {
  throw new Error("xhs_login_feishu_config_must_be_private");
}
let config;
try { config = parseLoginNotificationConfig(JSON.parse(await fs.readFile(file, "utf8"))); }
catch { throw new Error("invalid_xhs_login_feishu_config"); }

const pool = new pg.Pool({ connectionString: process.env.XHS_BATCH_DATABASE_URL, max: 2,
  connectionTimeoutMillis: 5000, statement_timeout: 10000 });
pool.on("error", () => console.error("xhs_login_notification_database_connection_error"));
const sender = createFeishuLoginSender(config);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

try {
  while (!stop.signal.aborted) {
    try { await notifyDailyLogouts(pool, config, sender); }
    catch { console.error("xhs_login_notification_poll_failed"); }
    await delay(60000, null, { signal: stop.signal }).catch(error => {
      if (error.name !== "AbortError") throw error;
    });
  }
} finally {
  await pool.end();
}
