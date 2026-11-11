import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { listDailyBatches, readDailyBatch } from "./admin-history.mjs";
import { createFeishuLoginSender, notifyDailyLogouts, parseLoginNotificationConfig } from "./feishu-login-notifier.mjs";

const root = new URL("../../", import.meta.url);
const LOGGED_OUT = "Xiaohongshu account is logged out; manual login is required";
const config = parseLoginNotificationConfig({
  webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-4000-8000-000000000000",
  clientId: "fixture", from: "2026-11-10T02:00:00+08:00",
});
const now = () => Date.parse("2026-11-10T10:00:00+08:00");
const id = char => char.repeat(64);
const item = (phone, status, reason = null) => ({
  itemId: phone, deviceId: "synthetic-device-" + phone, deviceName: phone, appSlot: "app2",
  xhsId: "synthetic-account-" + phone, accountName: `合成账号 ${phone}`, status, reason,
  jobId: status === "failed" ? "synthetic-job-" + phone : null,
  clientRequestId: "synthetic-request-" + phone, deferredAttempts: [{ jobId: "old-fixture" }],
});
const daily = (runId, fields = {}) => ({
  runId, clientId: config.clientId, status: "completed", requestId: "daily:2026-11-10",
  scheduledAt: config.from, completedAt: "2026-11-09T22:00:00.000Z", items: [], ...fields,
});

test("Feishu custom bot receives only a plain-text webhook request", async () => {
  const sent = [];
  const sender = createFeishuLoginSender(config, async (url, options) => {
    sent.push({ url, ...options, body: JSON.parse(options.body) });
    return Response.json({ code: 0, data: {} });
  });
  assert.deepEqual(await sender.send("合成通知"), { status: "sent" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, config.webhookUrl);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].headers.Authorization, undefined);
  assert.equal(sent[0].redirect, "error");
  assert.deepEqual(sent[0].body, { msg_type: "text", content: { text: "合成通知" } });
  assert.throws(() => parseLoginNotificationConfig({ ...config, from: "yesterday" }), /invalid/);
  for (const webhookUrl of [config.webhookUrl.replace("https:", "http:"),
    config.webhookUrl.replace("open.feishu.cn", "open.feishu.cn.invalid"), config.webhookUrl + "?q=1"]) {
    assert.throws(() => parseLoginNotificationConfig({ ...config, webhookUrl }), /^Error: invalid_xhs_login_feishu_config$/);
  }
});

test("Feishu webhook rejection and uncertain delivery are distinct", async () => {
  const send = response => createFeishuLoginSender(config, async () => response).send("合成通知");
  assert.deepEqual(await send(Response.json({ code: 19024 })), { status: "failed", errorCode: 19024 });
  assert.deepEqual(await send(Response.json({ code: 0 }, { status: 503 })), { status: "delivery_unknown" });
  assert.deepEqual(await send(Response.json({ msg: "incomplete" })), { status: "delivery_unknown" });
  const sender = createFeishuLoginSender(config, () => assert.fail("oversize body must not be posted"));
  assert.deepEqual(await sender.send("测".repeat(7000)), { status: "failed", reason: "webhook_payload_too_large" });
});

test("daily admin API and notifier use the real PostgreSQL schema", {
  skip: !process.env.XHS_BATCH_TEST_DATABASE_URL, timeout: 20_000,
}, async t => {
  const dbUrl = new URL(process.env.XHS_BATCH_TEST_DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(dbUrl.hostname) && dbUrl.pathname.startsWith("/xhs_batch_test_"));
  const pool = new pg.Pool({ connectionString: dbUrl.href });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-daily-http-"));
  const adminToken = "synthetic-daily-admin-test";
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: temp, STORAGE_BACKEND: "postgres", DATABASE_URL: dbUrl.href,
      ADMIN_API_TOKEN: adminToken, ADMIN_PASSWORD: "SyntheticAdminPassword!2026", REDIS_URL: "",
      SCREEN_MEDIA_TRANSPORT: "websocket", OPEN_NAME_LOOKUP_API_ENABLED: "false" },
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      await done;
    }
    await pool.end();
    await fs.rm(temp, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    assert.equal(child.exitCode, null, errors);
    ready = await fetch(origin + "/healthz").then(response => response.ok, () => false);
    if (!ready) await delay(35);
  }
  assert.ok(ready, errors);
  await pool.query(await fs.readFile(new URL("deploy/xhs-batch/schema.sql", root), "utf8"));
  const rows = [item("10", "succeeded"), item("11", "failed", "failed"), item("12", "failed", "failed"),
    item("13", "failed", "failed"), item("14", "skipped", "device_offline"), item("15", "failed", "failed"),
    item("16", "failed", "sensitive failure payload")];
  rows[1].accountName = '合成账号 <at id="all"> &\n次行';
  const completed = daily(id("a"), { items: rows });
  for (const run of [completed,
    daily(id("b"), { status: "running", items: [rows[1]] }),
    daily(id("c"), { requestId: "manual:fixture", scheduledAt: null, items: [rows[1]] }),
    daily(id("d"), { clientId: "other-fixture", items: [rows[1]] }),
    daily(id("e"), { scheduledAt: "2026-11-08T18:00:00.000Z", requestId: "daily:2026-11-09", items: [rows[1]] }),
  ]) await pool.query("insert into phone_cloud_xhs_batch_records(record_key, data) values($1,$2)",
    [`run/${run.runId}`, JSON.stringify(run)]);

  for (const [r, error, overrides] of [
    [rows[1], LOGGED_OUT], [rows[2], "login state lacks native element evidence"],
    [rows[3], LOGGED_OUT, { xhsAppSlot: "app1" }], [rows[5], "data-center loading timed out; UI elements incomplete"],
  ]) {
    await pool.query(`insert into phone_cloud_automation_jobs(job_id, device_id, user_id, kind, status, created_at, updated_at, data)
      values($1,$2,'fixture','xhs_data_collect','failed',now(),now(),$3)`,
    [r.jobId, r.deviceId, JSON.stringify({ xhsAppSlot: r.appSlot, xhsAccountId: r.xhsId, clientRequestId: r.clientRequestId,
      result: { diagnostic: { runnerReason: JSON.stringify({ error, sensitive: "never exposed" }) } }, ...overrides })]);
  }

  const api = "/api/v1/admin/xhs-daily-batches";
  const request = (route, token, body) => fetch(origin + route, {
    method: body ? "POST" : "GET", headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, body: body ? JSON.stringify(body) : undefined,
  });

  await t.test("only administrators see daily history and redacted slot reasons", async () => {
    const page = await (await request("/?page=xhs-daily-admin")).text();
    assert.match(page, /data-page-button="xhs-daily-admin" data-role-page="admin"/);
    assert.match(page, /xhsDailyAdminHost/);
    const script = await request("/xhs-daily-admin.js");
    assert.equal(script.status, 200);
    assert.match(await script.text(), /mountXhsDailyAdmin/);
    assert.equal((await request(api)).status, 401);
    const account = { username: "daily_viewer", password: "SyntheticViewer!2026", role: "user" };
    assert.equal((await request("/api/v1/users", adminToken, account)).status, 201);
    const login = await (await request("/api/v1/auth/login", null, account)).json();
    assert.ok(login.session.token);
    assert.equal((await request(api, login.session.token)).status, 401);
    assert.equal((await request(`${api}/${completed.runId}`, login.session.token)).status, 401);
    const response = await request(api, adminToken);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const list = await response.json();
    assert.equal(list.batches.length, 4);
    assert.equal(list.batches[0].runId, completed.runId);
    assert.equal((await request(api + "?offset=-1", adminToken)).status, 400);
    assert.equal((await request(api + "/" + id("c"), adminToken)).status, 404);
    const { batch } = await (await request(api + "/" + completed.runId, adminToken)).json();
    assert.deepEqual(batch.counts, { total: 7, succeeded: 1, failed: 5, skipped: 1, pending: 0 });
    assert.deepEqual(batch.items.map(r => r.reason), ["complete", "confirmed_logged_out", "collection_failed",
      "task_details_unavailable", "device_offline", "element_loading_timeout", "task_details_unavailable"]);
    assert.doesNotMatch(JSON.stringify(batch), /synthetic-account|synthetic-device|never exposed|sensitive failure payload/);
    assert.equal((await listDailyBatches(pool, { limit: 1 })).nextOffset, 1);
    assert.equal(await readDailyBatch(pool, completed.runId, { clientId: "another-client" }), null);
  });

  await t.test("one confirmed-logout message per eligible completed batch, including concurrent workers", async () => {
    const sends = [];
    const sender = {
      send: async text => { sends.push(text); return { status: "sent" }; },
    };
    await Promise.all([notifyDailyLogouts(pool, config, sender, now), notifyDailyLogouts(pool, config, sender, now)]);
    await notifyDailyLogouts(pool, config, sender, now);
    assert.equal(sends.length, 1);
    assert.equal(sends[0], '11号手机（副 App）：小红书账号「合成账号  at id="all"    次行」掉线。');
    const claim = (await pool.query("select data from phone_cloud_xhs_batch_records where starts_with(record_key,'notice/')")).rows[0].data;
    assert.equal(claim.status, "sent");
    assert.equal(claim.count, 1);
    assert.deepEqual((await pool.query("select data from phone_cloud_xhs_batch_records where record_key=$1",
      [`run/${completed.runId}`])).rows[0].data, completed);
  });

  await t.test("an ambiguous send result is kept and never replayed", async () => {
    const run = daily(id("f"), { items: [rows[1]] });
    await pool.query("insert into phone_cloud_xhs_batch_records(record_key, data) values($1,$2)",
      [`run/${run.runId}`, JSON.stringify(run)]);
    let count = 0;
    const sender = { send: async () => { count++; throw new Error("timeout"); } };
    await notifyDailyLogouts(pool, config, sender, now);
    await notifyDailyLogouts(pool, config, sender, now);
    assert.equal(count, 1);
    const notice = (await pool.query("select data from phone_cloud_xhs_batch_records where record_key=$1",
      [`notice/xhs-logged-out/${run.runId}`])).rows[0].data;
    assert.equal(notice.status, "delivery_unknown");
  });
});
