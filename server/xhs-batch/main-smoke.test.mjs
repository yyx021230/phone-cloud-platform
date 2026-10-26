import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { signRequest } from "./http.mjs";
import pg from "pg";

test("real service + PostgreSQL + Python SDK + simulated platform, restart keeps job/result", { skip: !process.env.XHS_BATCH_TEST_DATABASE_URL, timeout: 40_000 }, async t => {
  const dbUrl = new URL(process.env.XHS_BATCH_TEST_DATABASE_URL);
  assert.equal(dbUrl.hostname, "127.0.0.1"); assert.ok(dbUrl.pathname.startsWith("/xhs_batch_test_"));
  const pool = new pg.Pool({ connectionString: dbUrl.href });
  await pool.query(await fs.readFile(new URL("../../deploy/xhs-batch/schema.sql", import.meta.url), "utf8")); await pool.end();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-batch-service-"));
  let posts = 0, job;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const startDay = new Date(Date.parse(today) - 29 * 86400_000).toISOString().slice(0, 10);
  const platform = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain fixture body */ }
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/auth/login")) return res.end(JSON.stringify({ session: { token: "fixture" }, user: { role: "user" } }));
    if (req.url.endsWith("/user/devices")) return res.end(JSON.stringify({ devices: [{ deviceId: "smoke", adbOnline: true, xhsDataCollectionReady: true,
      xhsAccounts: [{ appSlot: "app1", xhsId: "fixture_xhs", accountName: "Fixture" }] }] }));
    if (req.method === "POST") {
      posts++; job = { jobId: "fixture-job", kind: "xhs_data_collect", deviceId: "smoke", xhsAppSlot: "app1", xhsAccountId: "fixture_xhs",
        xhsAccountName: "Fixture", accountIdentitySource: "platform_binding_snapshot", status: "succeeded", createdAt: new Date().toISOString(),
        result: { collection: { schema_version: 3, window_days: 30, app_slot: "app1", window_start_date: startDay, window_end_date: today,
          complete: true, stop_reason: "list_end_visible", notes: [{ title: "Fixture note", published_date: today, list_view_count: 12, list_like_count: 0, list_comment_count: 1 }] } } };
      res.statusCode = 201;
    }
    res.end(JSON.stringify({ task: job }));
  });
  platform.listen(0, "127.0.0.1"); await once(platform, "listening");
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const clientId = `smoke-${crypto.randomUUID()}`, secret = crypto.randomBytes(32).toString("hex");
  const configFile = path.join(temp, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ platformBaseUrl: `http://127.0.0.1:${platform.address().port}`, clients: [{ clientId, secret,
    username: "fixture", password: "fixture", targets: [{ deviceId: "smoke", appSlot: "app1", xhsId: "fixture_xhs", accountName: "Fixture" }] }] }), { mode: 0o600 });
  let child;
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); } };
  t.after(async () => { await stop(); platform.closeAllConnections(); platform.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function boot() {
    child = spawn(process.execPath, [new URL("./main.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH,
      XHS_BATCH_CONFIG_FILE: configFile, XHS_BATCH_DATABASE_URL: dbUrl.href, XHS_BATCH_PORT: String(port) }, stdio: "ignore" });
    for (let n = 0; n < 100; n++) {
      try { if ((await fetch(base + "/healthz")).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error("batch service startup failed");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("batch service not ready");
  }
  await boot();
  const python = `import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom xhs_batch_client import XhsBatchClient\ncfg=json.load(open(sys.argv[2]))['clients'][0]\nc=XhsBatchClient(sys.argv[3],cfg['clientId'],cfg['secret'])\nprint(json.dumps(c.create_batch('service-smoke-001')))\n`;
  const created = await promisify(execFile)("python3", ["-c", python, new URL("../../sdk/", import.meta.url).pathname, configFile, base],
    { env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
  const runId = JSON.parse(created.stdout).batch.runId;
  async function detail() {
    const target = `/api/v1/open/xhs-data/batches/${runId}`, timestamp = String(Date.now()), nonce = crypto.randomUUID();
    const response = await fetch(base + target, { headers: { "x-client-id": clientId, "x-timestamp": timestamp, "x-nonce": nonce,
      "x-signature": signRequest(secret, "GET", target, timestamp, nonce) } });
    return response.json();
  }
  for (let n = 0; n < 65 && !(await detail()).items[0].jobId; n++) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(posts, 1);
  await stop(); await boot();
  let result;
  for (let n = 0; n < 65; n++) { result = await detail(); if (result.complete) break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.equal(result.complete, true); assert.equal(posts, 1);
  assert.equal(result.items[0].data.notes[0].list_view_count, 12);
  assert.equal(result.items[0].accountName, "Fixture");
});
