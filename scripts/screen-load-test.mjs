import fs from "node:fs/promises";
import { WebSocket } from "ws";

import { buildLoadReport } from "./screen-load-report.mjs";
import { buildScreenTransportUrls } from "../screen-client/screen-transport.js";

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || process.env.PHONE_CLOUD_BASE_URL || "").replace(/\/$/, "");
const username = String(args.username || process.env.PHONE_CLOUD_USERNAME || "admin");
const password = String(process.env.PHONE_CLOUD_PASSWORD || "");
const deviceIds = String(args.devices || "").split(",").map((value) => value.trim()).filter(Boolean);
const durationMs = bounded(args.durationMs, 10_000, 8 * 60 * 60_000, 60_000);
const actionIntervalMs = bounded(args.actionIntervalMs, 500, 60_000, 5_000);
const includeSwipe = Boolean(args.swipe);
const includeTap = Boolean(args.tap);
const probeText = String(args.text || "").trim().slice(0, 32);

if (!baseUrl || !password || !deviceIds.length) {
  console.error("usage: PHONE_CLOUD_PASSWORD=... node scripts/screen-load-test.mjs --base-url http://host --devices id1,id2 [--duration-ms 60000] [--action-interval-ms 5000] [--tap] [--swipe] [--text PC] [--output report.json]");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const login = await request("/api/v1/auth/login", { method: "POST", body: { username, password } });
const token = login.session.token;
const sessions = await Promise.all(deviceIds.map((deviceId) => runSession({
  token,
  deviceId,
  durationMs,
  actionIntervalMs,
  includeSwipe,
  includeTap,
  probeText
})));
const report = buildLoadReport({
  startedAt,
  completedAt: new Date().toISOString(),
  requestedConcurrency: deviceIds.length,
  sessions
});
const output = `${JSON.stringify(report, null, 2)}\n`;

if (args.output) await fs.writeFile(String(args.output), output, "utf8");
process.stdout.write(output);
process.exitCode = report.sessions.failed || report.sessions.releaseFailures ? 1 : 0;

async function runSession({ token: authToken, deviceId, durationMs: runDurationMs, actionIntervalMs: cadenceMs, includeSwipe: shouldSwipe, includeTap: shouldTap, probeText: text }) {
  const startedAtMs = Date.now();
  const result = {
    deviceId,
    sessionId: "",
    firstFrameMs: -1,
    videoPackets: 0,
    videoBytes: 0,
    acknowledgements: [],
    statuses: [],
    failures: [],
    released: false
  };
  let controlSocket = null;
  let videoSocket = null;
  let sequenceId = 0;
  const pending = new Map();

  try {
    const created = await request(`/api/v1/user/devices/${encodeURIComponent(deviceId)}/screen-sessions`, { method: "POST", token: authToken });
    result.sessionId = created.session.sessionId;
    const urls = buildScreenTransportUrls(baseUrl, result.sessionId, created.browserToken);
    controlSocket = new WebSocket(urls.controlUrl);
    videoSocket = new WebSocket(urls.videoUrl);

    const firstVideo = new Promise((resolve, reject) => {
      videoSocket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        result.videoPackets += 1;
        result.videoBytes += data.byteLength;
        if (result.firstFrameMs < 0) {
          result.firstFrameMs = Date.now() - startedAtMs;
          resolve();
        }
      });
      controlSocket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString("utf8"));
        if (message.type === "status") {
          result.statuses.push({ atMs: Date.now() - startedAtMs, status: message.status, detail: message.detail || "" });
          if (message.status === "failed") reject(new Error(message.detail || "screen_failed"));
          return;
        }
        if (message.type !== "screen_control_ack") return;
        const item = pending.get(message.sequenceId);
        const acknowledgement = {
          sequenceId: message.sequenceId,
          action: message.action,
          status: message.status,
          agentElapsedMs: Math.max(0, Number(message.agentElapsedMs || 0)),
          roundTripMs: item ? Date.now() - item.sentAt : -1
        };
        result.acknowledgements.push(acknowledgement);
        if (!item) return;
        pending.delete(message.sequenceId);
        clearTimeout(item.timer);
        if (message.status === "failed") item.reject(new Error(message.error || "screen_control_failed"));
        else item.resolve(acknowledgement);
      });
      controlSocket.once("error", reject);
      videoSocket.once("error", reject);
      controlSocket.once("close", () => reject(new Error("screen_control_socket_closed_before_first_frame")));
      videoSocket.once("close", () => reject(new Error("screen_video_socket_closed_before_first_frame")));
    });

    await Promise.all([waitForOpen(controlSocket, 15_000), waitForOpen(videoSocket, 15_000)]);
    await withTimeout(firstVideo, 30_000, "screen_first_frame_timeout");
    const deadline = Date.now() + runDurationMs;
    let cycle = 0;
    while (Date.now() < deadline) {
      cycle += 1;
      await sendControl({ type: "key", key: "home" });
      await delay(200);
      if (shouldTap) await sendTap();
      await delay(120);
      await sendControl({ type: "key", key: "overview" });
      await delay(200);
      await sendControl({ type: "key", key: "back" });
      if (text && cycle % 2 === 1) await sendControl({ type: "text", text: probeText });
      if (shouldSwipe && cycle % 3 === 0) await sendSwipe();
      await delay(Math.min(cadenceMs, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    result.failures.push(error?.message || String(error));
  } finally {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("screen_test_finished"));
    }
    pending.clear();
    if (controlSocket?.readyState < WebSocket.CLOSING) controlSocket.close(1000, "load_test_finished");
    if (videoSocket?.readyState < WebSocket.CLOSING) videoSocket.close(1000, "load_test_finished");
    if (result.sessionId) {
      try {
        await request(`/api/v1/screen-sessions/${encodeURIComponent(result.sessionId)}`, { method: "DELETE", token: authToken });
        result.released = true;
      } catch (error) {
        result.failures.push(`release:${error?.message || String(error)}`);
      }
    }
    result.durationMs = Date.now() - startedAtMs;
  }

  return result;

  function sendControl(control) {
    if (controlSocket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("screen_control_socket_not_open"));
    const message = { ...control, sequenceId: ++sequenceId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.sequenceId);
        reject(new Error(`control_ack_timeout:${message.sequenceId}:${control.type}:${control.action || control.key || ""}`));
      }, 5_000);
      pending.set(message.sequenceId, { sentAt: Date.now(), resolve, reject, timer });
      controlSocket.send(JSON.stringify(message));
    });
  }

  async function sendTap() {
    const width = 720;
    const height = 1600;
    const pointerId = 2;
    const x = Math.round(width * 0.03);
    const y = Math.round(height * 0.03);
    await sendControl({ type: "touch", action: "down", pointerId, x, y, videoWidth: width, videoHeight: height });
    await sendControl({ type: "touch", action: "up", pointerId, x, y, videoWidth: width, videoHeight: height });
  }

  async function sendSwipe() {
    const width = 720;
    const height = 1600;
    const pointerId = 1;
    const x = Math.round(width * 0.5);
    const startY = Math.round(height * 0.72);
    const endY = Math.round(height * 0.36);
    await sendControl({ type: "touch", action: "down", pointerId, x, y: startY, videoWidth: width, videoHeight: height });
    for (let index = 1; index <= 4; index += 1) {
      await sendControl({
        type: "touch",
        action: "move",
        pointerId,
        x,
        y: Math.round(startY + (endY - startY) * index / 4),
        videoWidth: width,
        videoHeight: height
      });
    }
    await sendControl({ type: "touch", action: "up", pointerId, x, y: endY, videoWidth: width, videoHeight: height });
  }
}

async function request(pathname, { method = "GET", token = "", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${pathname}:${response.status}:${payload.error || text}`);
  return payload;
}

function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return withTimeout(new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  }), timeoutMs, "screen_socket_open_timeout");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (values[index + 1] && !values[index + 1].startsWith("--")) parsed[key] = values[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
