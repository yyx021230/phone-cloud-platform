import assert from "node:assert/strict";
import pg from "pg";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("collection API enforces ownership, locks and completion, preserves result on restart", { timeout: 30_000 }, async (t) => {
  const databaseUrl = process.env.XHS_COLLECTION_TEST_DATABASE_URL || "";
  if (databaseUrl) {
    const u = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost"].includes(u.hostname) && u.pathname === "/xhs_collection_fixture", "isolated fixture database required");
  }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-data-http-"));
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let server;
  let output = "";
  const stop = async () => { if (server && server.exitCode === null) { server.kill(); await once(server, "exit"); } };
  t.after(async () => { await stop(); await fs.rm(storage, { recursive: true, force: true }); });
  const start = async () => {
    server = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: storage, DATABASE_URL: databaseUrl, STORAGE_BACKEND: databaseUrl ? "postgres" : "json", STRUCTURED_WRITES: "true", REDIS_URL: "", ADMIN_USERNAME: "fixture_admin",
      ADMIN_PASSWORD: "fixture-admin-only", SCREEN_MEDIA_AUTH_SECRET: "fixture-collection-secret",
      PUBLIC_BASE_URL: base, WINDOWS_AGENT_ONLINE_SECONDS: "300"
    }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(`fixture server failed: ${output.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("fixture server did not start");
  };
  const request = async (method, route, token, body, expected = 200) => {
    const response = await fetch(`${base}${route}`, { method, headers: {
      "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${result.error || "unexpected status"}`);
    return result;
  };
  await start();
  const admin = (await request("POST", "/api/v1/auth/login", "", { username: "fixture_admin", password: "fixture-admin-only" })).session.token;
  for (const username of ["fixture_a", "fixture_b"]) {
    await request("POST", "/api/v1/users", admin, { username, password: "fixture-user-only", role: "user", enabled: true }, 201);
  }
  const login = async (username) => (await request("POST", "/api/v1/auth/login", "", { username, password: "fixture-user-only" })).session.token;
  const a = await login("fixture_a"); const b = await login("fixture_b");
  const agent = (await request("POST", "/api/v1/windows-agents", admin, { agentId: "fixture-agent", agentName: "Fixture" }, 201)).token;
  const sync = async (ready) => request("POST", "/api/v1/windows-agents/fixture-agent/devices/sync", agent, {
    agent: { agentId: "fixture-agent", health: { xhsDataCollect: { protocol: "xhs_data_collect_v1", ready } } },
    devices: [{ adbSerial: "FIXTURE_SERIAL", state: "device", model: "Fixture", automation: { ok: false, xhsInstalled: true } }]
  });
  await sync(false);
  const device = (await request("GET", "/api/v1/devices", admin)).devices.find((item) => item.adb?.serial === "FIXTURE_SERIAL");
  await request("PUT", `/api/v1/devices/${encodeURIComponent(device.deviceId)}`, admin, { listingStatus: "listed", deviceName: "Fixture102" });
  await request("PUT", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/xhs-accounts`, admin, {
    accounts: [{ appSlot: "app1", label: "小红书 1", xhsId: "fixture_xhs", accountName: "Fixture", enabled: true }]
  });
  const route = "/api/v1/user/automation/xhs-data-tasks";
  const input = { deviceId: device.deviceId, xhsAppSlot: "app1" };
  await request("POST", route, "", input, 401);
  await request("POST", route, a, { ...input, xhsAppSlot: "wrong" }, 400);
  await request("POST", route, a, input, 409);
  await sync(true);
  let created;
  if (databaseUrl) {
    const database = new pg.Client({ connectionString: databaseUrl });
    await database.connect();
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE phone_cloud_automation_jobs IN ACCESS EXCLUSIVE MODE");
      const creation = request("POST", route, a, input, 201);
      // Wait until the server transaction actually blocks on our table lock.
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await database.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()");
        if (waiting.rowCount) break;
        assert.ok(attempt < 99, "creation must reach pending database commit");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal((await request("GET", "/api/v1/windows-agents/fixture-agent/tasks/next", agent)).task, null,
        "an uncommitted collection must not reach the phone");
      await database.query("COMMIT");
      created = (await creation).task;
    } finally { await database.query("ROLLBACK"); await database.end(); }
  } else {
    created = (await request("POST", route, a, input, 201)).task;
  }
  assert.equal(created.kind, "xhs_data_collect");
  await request("POST", route, b, input, 409);
  await request("POST", `${route}/${created.jobId}/cancel`, b, {}, 404);
  await request("GET", `${route}/${created.jobId}`, b, undefined, 404);
  assert.equal((await request("GET", route, b)).tasks.length, 0);
  const picked = (await request("GET", "/api/v1/windows-agents/fixture-agent/tasks/next", agent)).task;
  assert.equal(picked.type, "xhs_data_collect");
  assert.equal(picked.payload.deviceName, "Fixture102");
  assert.equal(picked.payload.automationJobId, created.jobId);
  const snapshot = { schema_version: 3, window_days: 30, app_slot: "app1", window_start_date: "2026-09-14",
    window_end_date: "2026-10-13", complete: true, stop_reason: "list_end_visible", notes: [
      { title: "Fixture note", published_date: "2026-10-12", list_view_count: 12, list_like_count: 0, list_comment_count: 1 }
    ] };
  await request("POST", `/api/v1/windows-agent-tasks/${picked.taskId}/status`, agent,
    { status: "succeeded", result: { collection: { ...snapshot, window_days: 180 } } }, 400);
  assert.equal((await request("GET", `${route}/${created.jobId}`, a)).task.status, "running");
  await request("POST", `/api/v1/windows-agent-tasks/${picked.taskId}/status`, agent,
    { status: "succeeded", result: { collection: snapshot, message: "已采集" } });
  const detail = (await request("GET", `${route}/${created.jobId}`, a)).task;
  assert.equal(detail.status, "succeeded");
  assert.equal(detail.result.collection.notes[0].list_like_count, 0);
  const summary = (await request("GET", route, a)).tasks[0];
  assert.equal(summary.result.collection.notes, undefined);
  assert.equal(summary.result.collection.note_count, 1);

  // Completion released the device lock. Cancellation stays terminal against late results.
  const second = (await request("POST", route, a, input, 201)).task;
  const secondPicked = (await request("GET", "/api/v1/windows-agents/fixture-agent/tasks/next", agent)).task;
  await request("POST", `${route}/${second.jobId}/cancel`, a, {});
  const cancelled = await request("GET", `/api/v1/windows-agents/fixture-agent/tasks/next?activeTaskIds=${secondPicked.taskId}`, agent);
  assert.ok(cancelled.cancelledTaskIds.includes(secondPicked.taskId));
  const late = await request("POST", `/api/v1/windows-agent-tasks/${secondPicked.taskId}/status`, agent,
    { status: "succeeded", result: { collection: snapshot } });
  assert.equal(late.ignored, true);
  assert.equal((await request("GET", `${route}/${second.jobId}`, a)).task.status, "cancelled");

  const third = (await request("POST", route, a, input, 201)).task;
  const thirdPicked = (await request("GET", "/api/v1/windows-agents/fixture-agent/tasks/next", agent)).task;
  await request("POST", `/api/v1/windows-agent-tasks/${thirdPicked.taskId}/status`, agent,
    { status: "succeeded", result: { collection: { ...snapshot, complete: false, stop_reason: null } } });
  const incomplete = (await request("GET", `${route}/${third.jobId}`, a)).task;
  assert.equal(incomplete.status, "failed");
  assert.equal(incomplete.result.collection.notes.length, 1);
  if (databaseUrl) {
    const database = new pg.Client({ connectionString: databaseUrl }); await database.connect();
    try {
      await database.query("CREATE FUNCTION fixture_reject_collection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture persistence failure'; END $$");
      await database.query("CREATE TRIGGER fixture_reject_collection BEFORE INSERT ON phone_cloud_automation_jobs FOR EACH ROW EXECUTE FUNCTION fixture_reject_collection()");
      await request("POST", route, a, input, 500);
      assert.equal((await request("GET", "/api/v1/windows-agents/fixture-agent/tasks/next", agent)).task, null,
        "failed persistence must not dispatch a phone operation");
    } finally {
      await database.query("DROP TRIGGER IF EXISTS fixture_reject_collection ON phone_cloud_automation_jobs");
      await database.query("DROP FUNCTION IF EXISTS fixture_reject_collection()"); await database.end();
    }
    const retry = (await request("POST", route, a, input, 201)).task;
    await request("POST", `${route}/${retry.jobId}/cancel`, a, {});
  }
  await stop(); await start();
  const restored = (await request("GET", `${route}/${created.jobId}`, a)).task;
  assert.equal(restored.result.collection.notes[0].title, "Fixture note");
});
