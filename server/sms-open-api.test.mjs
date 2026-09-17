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

test("isolated signed SMS API: Douyin Provider/notification/event, XHS, auth and terminal states", { timeout: 30_000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-douyin-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  // Copy code only. Never load the real project's .env, data, databases or
  // inherited service credentials; all API traffic stays on loopback.
  await fs.cp(path.join(root, "server"), path.join(temp, "server"), {
    recursive: true, filter: (source) => !source.endsWith(".test.mjs")
  });
  await fs.symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), "dir");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const adminToken = crypto.randomUUID();
  const deviceToken = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString("hex");
  child = spawn(process.execPath, [path.join(temp, "server/index.mjs")], {
    cwd: temp,
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: path.join(temp, "data"), STORAGE_BACKEND: "json", REDIS_URL: "", DATABASE_URL: "",
      ADMIN_API_TOKEN: adminToken, DEVICE_AGENT_TOKEN: deviceToken,
      WINDOWS_AGENT_TOKEN: crypto.randomUUID(), ADMIN_PASSWORD: crypto.randomUUID(),
      THIRD_PARTY_API_CLIENTS: `local-a:${secret},local-b:${secret}`,
      SCREEN_MEDIA_AUTH_SECRET: crypto.randomUUID(), SCREEN_MEDIA_TRANSPORT: "websocket"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-3000); });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) assert.fail(`isolated server exited (${child.exitCode})`);
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch { /* local startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "isolated server becomes ready");
  async function api(method, route, token, body) {
    const res = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json();
    assert.ok(res.ok, `local ${method} ${route} failed: ${data.error || res.status}`);
    return data;
  }
  function signedHeaders(method, route, raw, clientId = "local-a") {
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const signature = crypto.createHmac("sha256", secret).update([method, route, timestamp, nonce, hash].join("\n")).digest("hex");
    return { "Content-Type": "application/json", "X-Client-Id": clientId, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature };
  }
  async function signed(method, route, body, extra = {}) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(base + route, {
      method, headers: { ...signedHeaders(method, route, raw, extra.clientId), ...extra.headers },
      body: method === "GET" ? undefined : raw
    });
    return { status: res.status, data: await res.json() };
  }
  const agent = await api("POST", "/api/v1/windows-agents", adminToken, {
    agentId: "synthetic-agent", agentName: "Synthetic Agent"
  });
  await api("POST", "/api/v1/windows-agents/synthetic-agent/devices/sync", agent.token, {
    agent: { agentId: "synthetic-agent" }, devices: [{
      adbSerial: "SYNTHETIC-DY", state: "device", model: "Synthetic",
      sims: [{ slotIndex: 0, subscriptionId: 1, phoneNumber: "13800000006", enabled: true }]
    }]
  });
  const devices = await api("GET", "/api/v1/devices", adminToken);
  const deviceId = devices.devices.find((device) => device.adb?.serial === "SYNTHETIC-DY").deviceId;
  await api("PUT", `/api/v1/devices/${encodeURIComponent(deviceId)}`, adminToken, { listingStatus: "listed" });
  const prefix = "/api/v1/open/sms-code-requests";
  async function create(platform, key = crypto.randomUUID()) {
    const res = await signed("POST", prefix, { deviceId, phoneNumber: "13800000006", platform }, { headers: { "Idempotency-Key": key } });
    assert.ok([200, 201].includes(res.status));
    return res.data.request;
  }
  async function get(request) {
    const res = await signed("GET", `${prefix}/${request.requestId}`);
    assert.equal(res.status, 200);
    return res.data.request;
  }
  async function ingest(body, source = "windows-agent-adb", address = "10600000000", extra = {}) {
    return api("POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/sms-library/batch`, deviceToken, {
      messages: [{ messageKey: `sms:${crypto.randomUUID()}`, body, source, address, box: "inbox", messageAt: new Date().toISOString(), ...extra }]
    });
  }

  const key = crypto.randomUUID();
  const douyin = await create("DOUYIN", key);
  assert.equal(douyin.platform, "抖音");
  assert.equal((await create("抖音", key)).requestId, douyin.requestId);
  const xhs = await create("xhs");
  const tasks = await api("GET", "/api/v1/windows-agent-tasks?limit=20", adminToken);
  assert.equal(tasks.tasks.filter((task) => task.type === "sms_code_probe" && task.deviceId === deviceId).length, 1);
  for (const body of ["【抖音】您有2026条新消息", "【银行】验证码567890，用于抖音付款", "【TikTok】验证码234567", "【抖音】验证码123456789"]) {
    await ingest(body);
    assert.equal((await get(douyin)).status, "waiting");
    assert.equal((await get(xhs)).status, "waiting");
  }
  await ingest("【抖音】验证码345678，请勿泄露。");
  const received = await get(douyin);
  assert.equal(received.status, "received");
  assert.equal(received.code, "345678");
  assert.equal(received.platform, "抖音");
  assert.notEqual(received.phoneNumber, "13800000006");
  assert.equal((await get(xhs)).status, "waiting");
  await ingest("【小红书】验证码456789，请勿泄露。");
  assert.equal((await get(xhs)).code, "456789");

  const notification = await create("抖音");
  // Same digits as the XHS Provider above must remain a separate Douyin SMS.
  await ingest("验证码456789，请勿泄露。", "windows-agent-notification", "抖音");
  assert.equal((await get(notification)).code, "456789");
  const beforeReconcile = await api("GET", `/api/v1/sms-library?deviceId=${encodeURIComponent(deviceId)}`, adminToken);
  const douyinMessage = beforeReconcile.messages.find((sms) => sms.platform === "抖音" && sms.code === "456789");
  assert.ok(douyinMessage);
  assert.ok(beforeReconcile.messages.some((sms) => sms.platform === "小红书" && sms.code === "456789"));
  await ingest("【抖音】验证码456789，请勿泄露。");
  const afterReconcile = await api("GET", `/api/v1/sms-library?deviceId=${encodeURIComponent(deviceId)}`, adminToken);
  assert.equal(afterReconcile.total, beforeReconcile.total);
  const canonicalMessage = afterReconcile.messages.find((sms) => sms.messageId === douyinMessage.messageId);
  assert.equal(canonicalMessage.platform, "抖音");
  assert.ok(canonicalMessage.sourceAliases.includes("windows-agent-notification"));
  const eventOrder = await create("douyin");
  await api("POST", "/api/v1/sms-events", deviceToken, {
    deviceId, sender: "10600000000", platform: "未知平台",
    body: "【抖音】验证码678912，请勿泄露。", receivedAt: new Date().toISOString()
  });
  assert.equal((await get(eventOrder)).code, "678912");
  const cancelled = await create("抖音");
  assert.equal((await signed("POST", `${prefix}/${cancelled.requestId}/cancel`, {})).status, 200);
  await ingest("【抖音】验证码789123，请勿泄露。");
  assert.equal((await get(cancelled)).status, "cancelled");
  assert.equal((await get(douyin)).code, "345678");
  assert.equal((await signed("GET", `${prefix}/${douyin.requestId}`, undefined, { clientId: "local-b" })).status, 404);
  assert.equal((await signed("GET", `${prefix}/${douyin.requestId}`, undefined, { headers: { "X-Signature": "invalid" } })).status, 401);
  const pathForReplay = `${prefix}/${douyin.requestId}`;
  const headers = signedHeaders("GET", pathForReplay, "");
  assert.equal((await fetch(base + pathForReplay, { headers })).status, 200);
  assert.equal((await fetch(base + pathForReplay, { headers })).status, 401);
  assert.doesNotMatch(errors, /fatal|uncaught|unhandled|SyntaxError/i);
});
