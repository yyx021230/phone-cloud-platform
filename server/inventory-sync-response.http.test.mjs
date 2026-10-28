import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

test("actual platform: authenticated sync alone negotiates gzip; Agent fetch decodes it", { timeout: 30_000 }, async t => {
  const root = path.resolve(import.meta.dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "inventory-response-http-"));
  const reserve = http.createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const adminToken = randomUUID();
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], { cwd: temp,
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: temp,
      DATABASE_URL: "", STORAGE_BACKEND: "json", REDIS_URL: "", ADMIN_API_TOKEN: adminToken,
      ADMIN_PASSWORD: randomUUID(), SCREEN_MEDIA_AUTH_SECRET: randomUUID(), NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null) throw new Error(`fixture startup failed: ${stderr}`);
    try { if ((await fetch(base + "/readyz")).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(ready, "isolated platform must become ready");
  const agentId = "inventory-fixture";
  const created = await fetch(base + "/api/v1/windows-agents", { method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId, agentName: "Synthetic inventory" }) });
  assert.equal(created.status, 201); const token = (await created.json()).token;
  const syncPath = `/api/v1/windows-agents/${agentId}/devices/sync`;
  const input = { agent: { agentId }, devices: Array.from({ length: 140 }, (_, n) => ({
    adbSerial: `SYNTHETIC-${n}`, state: "device", model: `Fixture-${n}` })) };
  const rawRequest = (route, { method = "POST", encoding = "gzip", auth = token, value = input } = {}) => new Promise((resolve, reject) => {
    const body = method === "GET" ? null : Buffer.from(JSON.stringify(value));
    const req = http.request(base + route, { method, headers: { "accept-encoding": encoding,
      "content-type": "application/json", authorization: `Bearer ${auth}`, ...(body ? { "content-length": body.length } : {}) } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end(body);
  });
  const gz = await rawRequest(syncPath);
  assert.equal(gz.status, 200); assert.equal(gz.headers["content-encoding"], "gzip");
  const decoded = gunzipSync(gz.raw); const data = JSON.parse(decoded);
  assert.equal(data.devices.length, 140); assert.equal(data.agent.agentId, agentId);
  assert.ok(gz.raw.length < decoded.length / 4);
  assert.equal(Number(gz.headers["content-length"]), gz.raw.length);
  const inventory = await rawRequest("/api/v1/devices", { method: "GET", auth: adminToken });
  assert.equal(inventory.headers["content-encoding"], undefined);
  assert.deepEqual(data.devices, JSON.parse(inventory.raw).devices);
  const identity = await rawRequest(syncPath, { encoding: "gzip;q=0, identity" });
  assert.equal(identity.status, 200); assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(identity.raw).devices.length, 140);
  const denied = await rawRequest(syncPath, { auth: "synthetic-invalid-token" });
  assert.equal(denied.status, 401); assert.equal(denied.headers["content-encoding"], undefined);
  const heartbeat = await rawRequest("/api/v1/windows-agents/heartbeat", { value: { agentId } });
  assert.equal(heartbeat.status, 200); assert.equal(heartbeat.headers["content-encoding"], undefined);
  // Windows Agent uses Node fetch: it must still receive a complete decoded JSON object.
  const fetched = await fetch(base + syncPath, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal(fetched.headers.get("content-encoding"), "gzip");
  const viaFetch = await fetched.json(); assert.equal(viaFetch.devices.length, 140);
  assert.deepEqual(viaFetch.devices.map(d => d.deviceId).sort(), data.devices.map(d => d.deviceId).sort());
});
