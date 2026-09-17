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

test("isolated external name lookup API covers auth, idempotency, human resume and tenant isolation", { timeout: 30_000 }, async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "phone-cloud-name-api-test-"));
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
  const secret = crypto.randomBytes(32).toString("hex");
  const clients = ["partner-a", "partner-b"].map((clientId, index) => ({
    clientId, secret, username: index ? "external_lookup_b" : "external_lookup", deviceIds: ["adb:SYNTHETIC-LOOKUP"]
  }));
  child = spawn(process.execPath, [path.join(temp, "server/index.mjs")], {
    cwd: temp,
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      DATA_DIR: path.join(temp, "data"), STORAGE_BACKEND: "json", REDIS_URL: "", DATABASE_URL: "",
      ADMIN_API_TOKEN: adminToken, DEVICE_AGENT_TOKEN: crypto.randomUUID(), WINDOWS_AGENT_TOKEN: crypto.randomUUID(),
      ADMIN_PASSWORD: crypto.randomUUID(), THIRD_PARTY_API_CLIENTS: "",
      OPEN_NAME_LOOKUP_API_ENABLED: "true", OPEN_NAME_LOOKUP_CLIENTS_JSON: JSON.stringify(clients),
      SCREEN_MEDIA_AUTH_SECRET: crypto.randomUUID(), SCREEN_MEDIA_TRANSPORT: "websocket"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-3000); });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) assert.fail(`isolated server exited (${child.exitCode}): ${errors}`);
    try { ready = (await fetch(`${base}/readyz`)).ok; } catch { /* local startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "isolated server becomes ready");

  async function api(method, route, token, body) {
    const response = await fetch(base + route, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.ok(response.ok, `${method} ${route} failed: ${data.error || response.status}`);
    return data;
  }
  function signedHeaders(method, route, raw, clientId = "partner-a") {
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash("sha256").update(raw).digest("hex");
    const signature = crypto.createHmac("sha256", secret).update([method, route, timestamp, nonce, bodyHash].join("\n")).digest("hex");
    return { "Content-Type": "application/json", "X-Client-Id": clientId, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature };
  }
  async function signed(method, route, body, options = {}) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(base + route, {
      method,
      headers: { ...signedHeaders(method, route, raw, options.clientId), ...options.headers },
      body: method === "GET" ? undefined : raw
    });
    return { status: response.status, data: await response.json() };
  }
  async function nextTask(agentToken) {
    const response = await api("GET", "/api/v1/windows-agents/synthetic-agent/tasks/next", agentToken);
    assert.ok(response.task, "expected a queued Windows task");
    return response.task;
  }
  async function finishTask(agentToken, task, status, result) {
    return api("POST", `/api/v1/windows-agent-tasks/${task.taskId}/status`, agentToken, { status, result });
  }

  await api("POST", "/api/v1/users", adminToken, {
    username: "external_lookup", password: "ExternalLookup!2026", displayName: "External Lookup", role: "user"
  });
  await api("POST", "/api/v1/users", adminToken, {
    username: "external_lookup_b", password: "ExternalLookup!2026B", displayName: "External Lookup B", role: "user"
  });
  const createdAgent = await api("POST", "/api/v1/windows-agents", adminToken, {
    agentId: "synthetic-agent", agentName: "Synthetic Agent"
  });
  const agentToken = createdAgent.token;
  await api("POST", "/api/v1/windows-agents/synthetic-agent/devices/sync", agentToken, {
    agent: { agentId: "synthetic-agent" },
    devices: [{ adbSerial: "SYNTHETIC-LOOKUP", state: "device", model: "Synthetic" }]
  });
  await api("PUT", "/api/v1/devices/adb%3ASYNTHETIC-LOOKUP", adminToken, { listingStatus: "listed" });

  const prefix = "/api/v1/open/name-lookups";
  const listed = await signed("GET", `${prefix}/devices`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.devices.map((device) => device.deviceId), ["adb:SYNTHETIC-LOOKUP"]);

  const sessionKey = crypto.randomUUID();
  const startBody = { deviceId: "adb:SYNTHETIC-LOOKUP" };
  const start = await signed("POST", `${prefix}/sessions`, startBody, { headers: { "Idempotency-Key": sessionKey } });
  assert.equal(start.status, 201);
  const sessionId = start.data.session.sessionId;
  const replay = await signed("POST", `${prefix}/sessions`, startBody, { headers: { "Idempotency-Key": sessionKey } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.session.sessionId, sessionId);
  assert.equal((await signed("GET", `${prefix}/sessions/${sessionId}`, undefined, { clientId: "partner-b" })).status, 404);

  const startTask = await nextTask(agentToken);
  assert.equal(startTask.type, "alipay_name_start");

  const queryKey = crypto.randomUUID();
  const queryBody = { phoneNumber: "13800000005", clientReference: "order-000001", consentReference: "consent-000001" };
  const query = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, queryBody, { headers: { "Idempotency-Key": queryKey } });
  assert.equal(query.status, 202);
  const queryId = query.data.queryId;
  const queryReplay = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, queryBody, { headers: { "Idempotency-Key": queryKey } });
  assert.equal(queryReplay.status, 200);
  assert.equal(queryReplay.data.queryId, queryId);
  const second = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, {
    phoneNumber: "13800000010", clientReference: "order-000002", consentReference: "consent-000002"
  }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
  const third = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, {
    phoneNumber: "13800000004", clientReference: "order-000003", consentReference: "consent-000003"
  }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
  assert.equal(second.status, 202);
  assert.equal(third.status, 202);
  assert.equal(third.data.session.status, "starting");
  assert.equal(third.data.session.queuedCount, 3);
  assert.equal(third.data.session.results.find((result) => result.queryId === queryId).queuePosition, 1);
  assert.equal(third.data.session.results.find((result) => result.queryId === second.data.queryId).queuePosition, 2);
  assert.equal(third.data.session.results.find((result) => result.queryId === third.data.queryId).queuePosition, 3);
  await finishTask(agentToken, startTask, "succeeded", { currentAccount: "account-a" });
  const startedQueue = (await signed("GET", `${prefix}/sessions/${sessionId}`)).data.session;
  assert.equal(startedQueue.status, "querying");
  assert.equal(startedQueue.queuedCount, 2);
  const queryTask = await nextTask(agentToken);
  assert.equal(queryTask.type, "alipay_name_query");
  await finishTask(agentToken, queryTask, "failed", {
    errorCode: "alipay_human_verification_required", message: "alipay_human_verification_required",
    currentAccount: "account-a", diagnostic: { limitReason: "jigsaw_verification" }
  });
  const human = (await signed("GET", `${prefix}/sessions/${sessionId}`)).data.session;
  assert.equal(human.humanAction.type, "manual_jigsaw_verification");
  assert.equal(human.humanAction.queryId, queryId);
  assert.equal(human.humanAction.resumeAllowed, true);
  assert.equal(human.results.find((result) => result.queryId === queryId).phoneNumber, "138****0005");
  const blocked = await api("GET", "/api/v1/windows-agents/synthetic-agent/tasks/next", agentToken);
  assert.equal(blocked.task, null, "queued queries must pause behind the original puzzle result");

  const resume = await signed("POST", `${prefix}/sessions/${sessionId}/resume`, { queryId }, {
    headers: { "Idempotency-Key": crypto.randomUUID() }
  });
  assert.equal(resume.status, 202);
  const resumeTask = await nextTask(agentToken);
  assert.equal(resumeTask.payload.resumeAfterHumanVerification, true);
  assert.equal(resumeTask.payload.phoneNumber, "13800000005");
  await finishTask(agentToken, resumeTask, "succeeded", {
    realNameTailCharacter: "轩", alipayDisplayName: "宇轩(**轩)", currentAccount: "account-a"
  });
  const completed = (await signed("GET", `${prefix}/sessions/${sessionId}`)).data.session;
  const completedFirst = completed.results.find((result) => result.queryId === queryId);
  assert.equal(completedFirst.status, "succeeded");
  assert.equal(completedFirst.nameTailCharacter, "轩");

  const secondTask = await nextTask(agentToken);
  assert.equal(secondTask.payload.phoneNumber, "13800000010");
  await finishTask(agentToken, secondTask, "succeeded", {
    realNameTailCharacter: "明", alipayDisplayName: "小明(**明)", currentAccount: "account-b",
    accountSwitched: true, accountSwitchReason: "jigsaw_verification", accountSwitchCount: 1
  });
  const thirdTask = await nextTask(agentToken);
  assert.equal(thirdTask.payload.phoneNumber, "13800000004");
  await finishTask(agentToken, thirdTask, "succeeded", { notFound: true, currentAccount: "account-a" });
  const drained = (await signed("GET", `${prefix}/sessions/${sessionId}`)).data.session;
  assert.equal(drained.queuedCount, 0);
  assert.equal(drained.resultCount, 3);
  assert.equal(drained.resultsTruncated, false);
  assert.equal(drained.results.find((result) => result.queryId === second.data.queryId).status, "succeeded");
  assert.equal(drained.results.find((result) => result.queryId === third.data.queryId).status, "not_found");
  const secondDetail = await signed("GET", `${prefix}/sessions/${sessionId}/queries/${second.data.queryId}`);
  assert.equal(secondDetail.status, 200);
  assert.equal(secondDetail.data.query.clientReference, "order-000002");
  assert.equal(secondDetail.data.query.phoneNumber, "138****0010");
  assert.equal(secondDetail.data.query.accountSwitched, true);
  assert.equal(secondDetail.data.query.accountSwitchCount, 1);

  const fourth = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, {
    phoneNumber: "13800000002", clientReference: "order-000004", consentReference: "consent-000004"
  }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
  const fifth = await signed("POST", `${prefix}/sessions/${sessionId}/queries`, {
    phoneNumber: "13800000001", clientReference: "order-000005", consentReference: "consent-000005"
  }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
  assert.equal(fourth.status, 202);
  assert.equal(fifth.data.session.queuedCount, 1);

  const ended = await signed("POST", `${prefix}/sessions/${sessionId}/end`, {});
  assert.equal(ended.status, 202);
  const stopTask = await nextTask(agentToken);
  assert.equal(stopTask.type, "alipay_name_stop");
  await finishTask(agentToken, stopTask, "succeeded", {});
  const finalSession = (await signed("GET", `${prefix}/sessions/${sessionId}`)).data.session;
  assert.equal(finalSession.status, "ended");
  assert.equal(finalSession.queuedCount, 0);
  assert.equal(finalSession.results.find((result) => result.queryId === fifth.data.queryId).status, "cancelled");
  assert.doesNotMatch(errors, /fatal|uncaught|unhandled|SyntaxError/i);
});
