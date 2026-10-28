import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

test("online ADB spelling replaces stale inventory casing without renaming the platform device", { timeout: 30_000 }, async t => {
  const root = path.resolve(import.meta.dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "adb-identity-http-"));
  const reserve = http.createServer().listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const admin = randomUUID();
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
    cwd: temp,
    env: { PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp,
      STORAGE_BACKEND: "json", DATABASE_URL: "", REDIS_URL: "", ADMIN_API_TOKEN: admin,
      ADMIN_PASSWORD: randomUUID(), SCREEN_MEDIA_AUTH_SECRET: randomUUID(),
      MANAGED_NAME_LOOKUP_ENABLED: "false", OPEN_NAME_LOOKUP_API_ENABLED: "false" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  let relay;
  child.stderr.on("data", value => { stderr = (stderr + value).slice(-2000); });
  t.after(async () => {
    relay?.terminate();
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await stopped;
      clearTimeout(timer);
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) assert.fail(`fixture exited: ${stderr}`);
    try { if ((await fetch(base + "/readyz")).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready);
  const api = async (route, token, body, status = 200, method = body ? "POST" : "GET") => {
    const res = await fetch(base + route, { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    assert.equal(res.status, status, json.error);
    return json;
  };
  const agentId = "serial-case-fixture";
  const token = (await api("/api/v1/windows-agents", admin, { agentId }, 201)).token;
  const sync = async (serial, state = "device", deviceId) => api(`/api/v1/windows-agents/${agentId}/devices/sync`, token, {
    devices: [{ adbSerial: serial, state, deviceId, deviceName: "Fixture", recovery: { physicalPresent: true } }]
  });
  const initial = await sync("TESTAB12");
  const id = initial.devices[0].deviceId;
  const corrected = await sync("testab12", "device", "adb:testab12");
  assert.equal(corrected.devices.length, 1, "never creates a duplicate platform device");
  assert.equal(corrected.devices[0].deviceId, id, "stable platform ID is not a transport selector");
  assert.equal(corrected.devices[0].adb.serial, "testab12");
  const agent = (await api("/api/v1/windows-agents", admin)).agents.find(a => a.agentId === agentId);
  assert.equal(agent.devices.length, 1);
  assert.equal(agent.devices[0].adbSerial, "testab12");
  const missing = await sync("TESTAB12", "missing");
  assert.equal(missing.devices[0].adb.serial, "testab12", "PnP spelling must not overwrite a known ADB spelling");
  const online = await sync("TeStAb12");
  assert.equal(online.devices[0].adb.serial, "TeStAb12", "use the actual spelling, not unconditional lowercase");
  assert.equal(online.devices[0].deviceId, id);
  const unchanged = await sync("TeStAb12");
  assert.equal(unchanged.devices.length, 1);
  assert.equal(unchanged.devices[0].adb.serial, "TeStAb12");

  // Exercise the real HTTP -> relay downlink without an Agent or real device.
  await api(`/api/v1/devices/${encodeURIComponent(id)}`, admin, { listingStatus: "listed" }, 200, "PUT");
  relay = new WebSocket(`${base.replace("http:", "ws:")}/api/v1/windows-agents/${agentId}/screen-relay`, {
    headers: { authorization: `Bearer ${token}` }
  });
  await once(relay, "open");
  const messages = [];
  relay.on("message", data => { messages.push(JSON.parse(String(data))); });
  const created = await api(`/api/v1/user/devices/${encodeURIComponent(id)}/screen-sessions`, admin, {}, 201);
  for (let i = 0; i < 100 && !messages.some(message => message.type === "screen_start"); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const start = messages.find(message => message.type === "screen_start");
  assert.ok(start, "the actual relay sends screen_start to the mock socket");
  assert.equal(start.adbSerial, "TeStAb12");
  assert.equal(start.deviceId, id);
  assert.equal(start.sessionId, created.session.sessionId);
});
