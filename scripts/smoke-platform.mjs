import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const port = 18000 + Math.floor(Math.random() * 2000);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = path.join(os.tmpdir(), `phone-cloud-smoke-${Date.now()}`);

let server;

async function main() {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
  server = spawn(process.execPath, ["server/index.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin123",
      SCREEN_MEDIA_AUTH_SECRET: "local-smoke-screen-auth-secret",
      WINDOWS_AGENT_ONLINE_SECONDS: "120",
      MIN_PASSWORD_LENGTH: "8",
      MIN_MANAGED_USER_PASSWORD_LENGTH: "7"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  server.stdout.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForReady(logs);

  const admin = await login("admin", "admin123");
  const userA = await createUser(admin, "smoke_a", "ztqc258");
  const userB = await createUser(admin, "smoke_b", "ztqc258");
  const agentCreate = await api("POST", "/api/v1/windows-agents", admin, {
    agentId: "smoke-agent",
    agentName: "Smoke Windows Agent"
  });
  const agentToken = agentCreate.token;
  await api("POST", "/api/v1/windows-agents/smoke-agent/devices/sync", agentToken, {
    agent: {
      agentId: "smoke-agent",
      health: { airtest: { enabled: true, ok: true, pocoReady: true, pythonCommand: "python" } }
    },
    devices: [{
      adbSerial: "SMOKE123",
      state: "device",
      model: "X Test",
      manufacturer: "vivo",
      brand: "vivo",
      androidVersion: "14",
      batteryLevel: 88,
      sims: [{ slotIndex: 0, phoneNumber: "13800138000", carrierName: "测试运营商", enabled: true }],
      automation: {
        ok: true,
        airtestReady: true,
        pocoReady: true,
        yosemiteReady: true,
        helpersReady: true,
        status: "ready",
        xhsInstalled: true
      }
    }]
  });

  const devices = await api("GET", "/api/v1/devices", admin);
  const device = devices.devices.find((item) => item.adb?.serial === "SMOKE123");
  assert(device, "synced device should exist");
  await api("PUT", `/api/v1/devices/${encodeURIComponent(device.deviceId)}`, admin, { listingStatus: "listed", deviceName: "smoke-device" });
  await api("PUT", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/xhs-accounts`, admin, {
    accounts: [{ appSlot: "app1", label: "小红书", xhsId: "smoke_xhs_001", accountName: "烟测账号", enabled: true }]
  });

  await api("POST", "/api/v1/sms-orders", admin, {
    userId: userA.user.userId,
    deviceId: device.deviceId,
    phoneNumber: "13800138000",
    platform: "小红书"
  });
  const smsAt = new Date().toISOString();
  const notificationSmsPayload = {
    deviceId: device.deviceId,
    messages: [{
      messageKey: "notification:smoke-1",
      address: "10690000",
      phoneNumber: "13800138000",
      body: "【小红书】验证码 123456，5 分钟内有效。",
      code: "123456",
      messageAt: smsAt,
      box: "inbox",
      source: "windows-agent-notification"
    }]
  };
  const smsPayload = {
    deviceId: device.deviceId,
    messages: [{
      messageKey: "sms:1",
      smsId: "1",
      address: "10690000",
      phoneNumber: "13800138000",
      body: "【小红书】验证码 123456，5 分钟内有效。",
      code: "123456",
      messageAt: smsAt,
      slotIndex: 0,
      box: "inbox",
      source: "windows-agent-adb"
    }]
  };
  await api("POST", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/sms-library/batch`, "dev-device-token", notificationSmsPayload);
  await api("POST", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/sms-library/batch`, "dev-device-token", smsPayload);
  await api("POST", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/sms-library/batch`, "dev-device-token", smsPayload);

  const sessionA = await login("smoke_a", "ztqc258");
  const sessionB = await login("smoke_b", "ztqc258");
  const aSms = await api("GET", `/api/v1/user/devices/${encodeURIComponent(device.deviceId)}/sms-library`, sessionA);
  const bSms = await api("GET", `/api/v1/user/devices/${encodeURIComponent(device.deviceId)}/sms-library`, sessionB);
  assert(aSms.total === 1, `user A should see full device SMS library, got ${aSms.total}`);
  assert(bSms.total === 1, `user B should see full device SMS library for listed devices, got ${bSms.total}`);
  assert(aSms.messages[0]?.redacted === false, "user device SMS library should not be redacted");
  assert(String(aSms.messages[0]?.body || "").includes("123456"), "user device SMS library should include full message body");
  assert(aSms.messages[0]?.messageKey === "sms:1", "provider key should replace the notification fallback key");
  assert(aSms.messages[0]?.slotIndex === 0, "provider metadata should fill the notification-only SIM slot");
  assert(aSms.messages[0]?.sourceAliases?.includes("windows-agent-notification"), "merged SMS should retain its notification source alias");

  const repeatedBody = "相同验证码 888888";
  const repeatedBase = Date.now();
  await api("POST", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/sms-library/batch`, "dev-device-token", {
    messages: [
      { messageKey: "sms:2", smsId: "2", address: "10690001", body: repeatedBody, messageAt: new Date(repeatedBase - 60_000).toISOString(), box: "inbox", source: "windows-agent-adb" },
      { messageKey: "sms:3", smsId: "3", address: "10690001", body: repeatedBody, messageAt: new Date(repeatedBase - 10_000).toISOString(), box: "inbox", source: "windows-agent-adb" }
    ]
  });
  await api("POST", `/api/v1/devices/${encodeURIComponent(device.deviceId)}/sms-library/batch`, "dev-device-token", {
    messages: [{
      messageKey: "notification:smoke-nearest",
      address: "10690001",
      body: repeatedBody,
      messageAt: new Date(repeatedBase - 12_000).toISOString(),
      box: "inbox",
      source: "windows-agent-notification"
    }]
  });
  const repeatedSms = await api("GET", `/api/v1/user/devices/${encodeURIComponent(device.deviceId)}/sms-library`, sessionA);
  assert(repeatedSms.total === 3, `two real identical SMS messages must remain distinct, got ${repeatedSms.total}`);
  assert(repeatedSms.messages.find((message) => message.messageKey === "sms:3")?.sourceAliases?.includes("windows-agent-notification"), "notification should merge into the nearest provider message");

  const qr = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const firstTask = await api("POST", "/api/v1/user/xhs/qr-scan-tasks", sessionA, {
    deviceId: device.deviceId,
    xhsAppSlot: "app1",
    qrImageDataUrl: qr
  });
  assert(firstTask.task?.lockId, "created XHS task should include lockId");

  const conflict = await api("POST", "/api/v1/user/xhs/qr-scan-tasks", sessionB, {
    deviceId: device.deviceId,
    xhsAppSlot: "app1",
    qrImageDataUrl: qr
  }, { allowError: true });
  assert(conflict.status === 409 && ["account_slot_busy", "device_busy"].includes(conflict.body?.error), "second task should hit device/account lock");

  const locks = await api("GET", "/api/v1/device-locks", admin);
  const activeLock = locks.locks.find((lock) => lock.taskId === firstTask.task.taskId && lock.status === "active");
  assert(activeLock, "admin lock view should include active task lock");
  await api("POST", `/api/v1/device-locks/${activeLock.lockId}/release`, admin, {});

  const metrics = await api("GET", "/api/v1/metrics/operations", admin);
  assert(metrics.metrics?.queue, "operations metrics should include queue data");
  assert(Array.isArray(metrics.metrics?.activeLocks), "operations metrics should include active locks");

  console.log("smoke ok");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForReady(logs) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.status === 200) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`server did not become ready:\n${logs.join("")}`);
}

async function login(username, password) {
  const payload = await api("POST", "/api/v1/auth/login", "", { username, password });
  return payload.session.token;
}

async function createUser(token, username, password) {
  return api("POST", "/api/v1/users", token, { username, password, role: "user", enabled: true });
}

async function api(method, urlPath, token = "", body, options = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (options.allowError) return { status: response.status, body: payload };
    throw new Error(`${method} ${urlPath} failed ${response.status}: ${text}`);
  }
  return payload;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server && server.exitCode === null) {
      const closed = new Promise((resolve) => server.once("close", resolve));
      server.kill("SIGTERM");
      await Promise.race([closed, delay(3000)]);
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
