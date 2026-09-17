import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("isolated HTTP: legacy load, ingress, terminal updates, retention, timer expiry and restart", { timeout: 30_000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-history-test-"));
  const dataDir = path.join(temp, "data");
  const dataFile = path.join(dataDir, "state.json");
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
  t.after(async () => { await stop(); await fs.rm(temp, { recursive: true, force: true }); });
  // Code-only isolated process: no real .env, business data, credentials or
  // inherited database endpoints. Every request goes to this loopback server.
  await fs.cp(path.join(root, "server"), path.join(temp, "server"), {
    recursive: true, filter: source => !source.endsWith(".test.mjs")
  });
  await fs.symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
  await fs.mkdir(dataDir);
  const at = new Date().toISOString();
  const events = Array.from({ length: 105 }, (_, i) => ({
    eventId: `synthetic-${i}`, createdAt: new Date(Date.now() - 105_000 + i * 1000).toISOString(),
    message: "m".repeat(2100), uiSnapshot: "u".repeat(8100),
    uiHierarchyEvidence: { evidenceId: "synthetic-xml" }, uiHierarchyUrl: "/expired"
  }));
  const evidencePath = path.join(dataDir, "synthetic.xml");
  await fs.writeFile(evidencePath, "<synthetic />");
  await fs.writeFile(dataFile, JSON.stringify({
    windowsTasks: [{ taskId: "synthetic-windows", status: "failed", createdAt: at, updatedAt: at, events, result: { message: "retained" }, payload: { imageDataUrl: "remove-terminal-input" } }],
    xhsQrTasks: [
      { taskId: "synthetic-legacy", status: "running", createdAt: at, updatedAt: at, events: [], qrImageDataUrl: "keep-active-input" },
      { taskId: "synthetic-xhs", status: "running", createdAt: at, updatedAt: at, events: [] }
    ],
    automationJobs: [{ jobId: "synthetic-job", status: "succeeded", createdAt: at, updatedAt: at, events, result: { action: "retained-job" }, imageDataUrls: ["remove-terminal-input"] }],
    smsOrders: [{ orderId: "synthetic-expiry", status: "waiting", createdAt: at, updatedAt: at, expiresAt: new Date(Date.now() + 1000).toISOString() }],
    evidenceAssets: [{ evidenceId: "synthetic-xml", createdAt: at, filePath: evidencePath, mimeType: "application/xml" }]
  }));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const adminToken = crypto.randomUUID();
  const deviceToken = crypto.randomUUID();
  let errors = "";
  async function start() {
    child = spawn(process.execPath, [path.join(temp, "server/index.mjs")], {
      cwd: temp,
      env: {
        PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
        DATA_DIR: dataDir, STORAGE_BACKEND: "json", DATABASE_URL: "", REDIS_URL: "",
        ADMIN_API_TOKEN: adminToken, DEVICE_AGENT_TOKEN: deviceToken,
        WINDOWS_AGENT_TOKEN: crypto.randomUUID(), ADMIN_PASSWORD: crypto.randomUUID(),
        EVIDENCE_SIGNING_SECRET: "synthetic-only-evidence-key-32-chars", SCREEN_MEDIA_TRANSPORT: "websocket"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-3000); });
    for (let i = 0; i < 100; i++) {
      assert.equal(child.exitCode, null, "isolated server must remain alive");
      try { if ((await fetch(`${base}/readyz`)).ok) return; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("isolated server did not become ready");
  }
  async function api(method, route, body, token = adminToken) {
    const res = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json();
    assert.ok(res.ok, `${method} ${route}: ${data.error || res.status}`);
    return data;
  }
  async function stored() { return JSON.parse(await fs.readFile(dataFile, "utf8")); }
  await start();
  const initial = await api("GET", "/api/v1/windows-agent-tasks/synthetic-windows");
  assert.equal(initial.task.result.message, "retained");
  // Startup normalization must be complete before /readyz or the first read.
  const initialState = await stored();
  for (const task of [initialState.windowsTasks[0], initialState.automationJobs[0]]) {
    assert.equal(task.events.length, 100);
    assert.equal(task.events[0].eventId, "synthetic-5");
    assert.equal(task.events[0].message.length, 2000);
    assert.equal(task.events[0].uiSnapshot.length, 8000);
  }
  assert.equal(initialState.windowsTasks[0].payload.imageDataUrl, undefined);
  assert.equal(initialState.automationJobs[0].imageDataUrls, undefined);
  assert.equal(initialState.xhsQrTasks[0].qrImageDataUrl, "keep-active-input");
  const link = initialState.windowsTasks[0].events[0].uiHierarchyUrl;
  assert.equal(await (await fetch(base + link)).text(), "<synthetic />");
  for (const [id, route] of [["synthetic-legacy", "/api/v1/device-commands"], ["synthetic-xhs", "/api/v1/xhs/qr-scan-tasks"]]) {
    const running = await api("POST", `${route}/${id}/status`, { status: "running", result: { customProgress: "preserved" } }, deviceToken);
    assert.equal((running.command || running.task).result.customProgress, "preserved");
    await api("POST", `${route}/${id}/status`, { status: "succeeded", result: { message: "m".repeat(1100), uiSnapshot: "u".repeat(9000), action: "completed" } }, deviceToken);
    const ignored = await api("POST", `${route}/${id}/status`, { status: "running", result: { action: "must-not-overwrite" } }, deviceToken);
    assert.equal(ignored.ignored, true);
  }
  const late = await api("POST", "/api/v1/device-commands/synthetic-legacy/events", {
    message: "late-terminal-event", detail: { uiHierarchy: "x".repeat(90_000) }
  }, deviceToken);
  assert.equal(late.event.detail.uiHierarchy.length, 80_000);
  assert.equal((await api("GET", "/api/v1/device-commands/synthetic-legacy/events")).events[0].message, "late-terminal-event");
  // Observe the real ten-second maintenance timer, not a renamed test callback.
  const expiryDeadline = Date.now() + 13_000;
  let expired = false;
  while (Date.now() < expiryDeadline) {
    if ((await stored()).smsOrders[0].status === "expired") { expired = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(expired, "real maintenance timer still expires SMS orders and persists changes");
  await api("POST", "/api/v1/maintenance/prune", {});
  const saved = await stored();
  assert.equal(saved.xhsQrTasks[0].qrImageDataUrl, undefined);
  assert.equal(saved.xhsQrTasks[0].result.message.length, 1000);
  assert.equal(saved.xhsQrTasks[0].result.uiSnapshot.length, 8000);
  assert.equal(saved.xhsQrTasks[0].events[0].message, "late-terminal-event");
  await stop();
  await start();
  const restored = await api("GET", "/api/v1/device-commands/synthetic-legacy", undefined, deviceToken);
  assert.equal(restored.command.status, "succeeded");
  assert.equal(restored.command.result.action, "completed");
  assert.equal((await api("GET", "/api/v1/device-commands/synthetic-legacy/events")).events[0].detail.uiHierarchy.length, 80_000);
  assert.doesNotMatch(errors, /fatal|uncaught|unhandled|SyntaxError/i);
});
