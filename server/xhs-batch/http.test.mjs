import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { BatchEngine, validateClients } from "./engine.mjs";
import { createBatchHandler, signRequest } from "./http.mjs";
import { createPlatformClient } from "./platform.mjs";
import { memoryStore } from "./fixtures.mjs";

test("signed HTTP API: durable nonce, tampering, ownership, schedule, idempotent creation and pagination", async t => {
  const clients = validateClients(["a", "b"].map(id => ({ clientId: id, username: id, password: "fixture", secret: id.repeat(32),
    targets: [{ deviceId: id, appSlot: "app1", xhsId: id, accountName: id }] })));
  const store = memoryStore(), engine = new BatchEngine({ store, clients, platforms: new Map() });
  const server = http.createServer(createBatchHandler({ store, engine, clients }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, root = "/api/v1/open/xhs-data";
  async function request(id, method, target, value, overrides = {}) {
    const body = value === undefined ? "" : JSON.stringify(value), timestamp = String(Date.now()), nonce = crypto.randomUUID();
    const headers = { "content-type": "application/json", "x-client-id": id, "x-timestamp": timestamp, "x-nonce": nonce,
      "x-signature": signRequest(id.repeat(32), method, target, timestamp, nonce, body), ...overrides };
    const response = await fetch(base + target, { method, headers, body: body || undefined });
    return { status: response.status, body: await response.json(), headers };
  }
  assert.equal((await fetch(base + `${root}/schedule`)).status, 401);
  assert.equal((await request("a", "GET", `${root}/schedule`)).body.schedule.enabled, false);
  const good = await request("a", "GET", `${root}/schedule`);
  assert.equal((await fetch(base + `${root}/schedule`, { headers: good.headers })).status, 401);
  const tampered = { ...good.headers, "x-nonce": crypto.randomUUID() };
  assert.equal((await fetch(base + `${root}/schedule`, { headers: tampered })).status, 401);
  assert.equal((await request("a", "PUT", `${root}/schedule`, { enabled: true, time: "02:00", windowMinutes: 240, concurrency: 5 })).status, 200);
  const run = (await request("a", "POST", `${root}/batches`, { requestId: "manual-test-1" })).body.batch;
  assert.equal((await request("a", "POST", `${root}/batches`, { requestId: "manual-test-1" })).body.batch.runId, run.runId);
  assert.equal((await request("a", "POST", `${root}/batches`, { requestId: "manual-test-2" })).status, 409);
  assert.equal((await request("b", "GET", `${root}/batches/${run.runId}`)).status, 404);
  const detail = await request("a", "GET", `${root}/batches/${run.runId}?offset=0&limit=1`);
  assert.equal(detail.body.items[0].xhsId, "a"); assert.equal(detail.body.items[0].data, null);
  assert.equal((await fetch(base + `${root}/batches/${run.runId}?offset=1&limit=1`, { headers: detail.headers })).status, 401);
  assert.equal((await request("b", "GET", `${root}/batches`)).body.batches.length, 0);
  assert.equal((await request("a", "POST", `${root}/batches`, { requestId: "daily:2026-10-26" })).status, 400);
  assert.equal((await request("a", "POST", `${root}/batches`, {})).status, 400);
  assert.equal((await request("a", "POST", `${root}/batches`, { requestId: 12345678 })).status, 400);
  assert.equal((await request("a", "GET", `${root}/batches?offset=-1`)).status, 400);
});

test("platform POST is never replayed on timeout, redirect, 401 or invalid response", async () => {
  for (const fail of ["timeout", "401", "invalid"]) {
    let posts = 0;
    const platform = createPlatformClient({ baseUrl: "http://127.0.0.1:8787", username: "fixture", password: "fixture",
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, "error");
        if (url.pathname.endsWith("/auth/login")) return new Response(JSON.stringify({ session: { token: "fixture" }, user: { role: "user" } }));
        posts++;
        if (fail === "timeout") throw new Error("connection lost");
        if (fail === "401") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        return new Response("broken-json");
      } });
    await assert.rejects(platform.submit({ deviceId: "a", appSlot: "app1" })); assert.equal(posts, 1);
  }
  for (const baseUrl of ["ftp://remote.example", "file:///tmp/platform", "http://remote.example/path", "http://remote.example?secret=x", "http://remote.example#fragment"]) {
    assert.throws(() => createPlatformClient({ baseUrl }), /invalid_platform_url/);
  }
  assert.throws(() => createPlatformClient({ baseUrl: "https://user:secret@remote.example" }), /invalid_platform_url/);
  let adminCalls = 0;
  const admin = createPlatformClient({ baseUrl: "http://127.0.0.1:8787", username: "fixture", password: "fixture",
    fetchImpl: async () => { adminCalls++; return new Response(JSON.stringify({ session: { token: "fixture" }, user: { role: "admin" } })); } });
  await assert.rejects(admin.submit({ deviceId: "a", appSlot: "app1" }), /ordinary_user_required/);
  assert.equal(adminCalls, 1);
});

test("public HTTP platform URLs keep ordinary-user login, contract checks and submission identity", async () => {
  const requests = [];
  const p = createPlatformClient({ baseUrl: "http://platform.example:8787", username: "fixture", password: "fixture",
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, ...options });
      assert.equal(url.origin, "http://platform.example:8787");
      assert.equal(options.redirect, "error");
      if (url.pathname.endsWith("/auth/login")) return Response.json({ session: { token: "fixture" }, user: { role: "user" } });
      assert.equal(options.headers.authorization, "Bearer fixture");
      if (url.pathname.endsWith("/devices")) return Response.json({ devices: [] });
      if (options.method === "GET") return Response.json({ batchContract: { version: 1, expectedXhsId: true, identitySnapshot: true, submissionLookup: true } });
      return Response.json({ task: { jobId: "original-job" } });
    } });
  assert.deepEqual(await p.devices(), []);
  assert.equal((await p.submit({ deviceId: "device-a", appSlot: "app2", xhsId: "xhs-a", clientRequestId: "original-reference" })).jobId, "original-job");
  const sent = requests.filter(r => r.method === "POST" && !r.url.endsWith("/auth/login"));
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0].body), { deviceId: "device-a", xhsAppSlot: "app2", expectedXhsId: "xhs-a", clientRequestId: "original-reference" });
});

test("old platform capability is rejected before any phone task is submitted", async () => {
  const calls = [];
  const p = createPlatformClient({ baseUrl: "http://127.0.0.1:8787", username: "fixture", password: "fixture",
    fetchImpl: async (url, options) => {
      calls.push([options.method, url.pathname]);
      return new Response(JSON.stringify(url.pathname.endsWith("/auth/login")
        ? { session: { token: "fixture" }, user: { role: "user" } } : { tasks: [] }));
    } });
  await assert.rejects(p.devices(), /platform_batch_contract_required/);
  assert.equal(calls.filter(([m, p]) => m === "POST" && !p.endsWith("/auth/login")).length, 0);
});
