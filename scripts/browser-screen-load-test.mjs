import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import { WebSocket } from "ws";

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || process.env.PHONE_CLOUD_BASE_URL || "").replace(/\/$/, "");
const username = String(args.username || process.env.PHONE_CLOUD_USERNAME || "admin");
const password = String(process.env.PHONE_CLOUD_PASSWORD || "");
const deviceIds = String(args.devices || "").split(",").map((value) => value.trim()).filter(Boolean);
const qualityProfile = String(args.qualityProfile || "auto").trim().toLowerCase();
const durationMs = bounded(args.durationMs, 10_000, 30 * 60_000, 90_000);
const chromePath = String(args.chromePath || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const debugPort = bounded(args.debugPort, 1024, 65535, 9322);
const profileDir = String(args.profileDir || `/tmp/phone-cloud-browser-probe-${randomUUID()}`);

if (!baseUrl || !password || !deviceIds.length) {
  console.error("usage: PHONE_CLOUD_PASSWORD=... node scripts/browser-screen-load-test.mjs --base-url http://host --devices id1,id2 [--duration-ms 90000]");
  process.exit(2);
}

const startedAtMs = Date.now();
const login = await request("/api/v1/auth/login", { method: "POST", body: { username, password } });
const token = login.session.token;
const created = [];
const probes = [];
let chrome = null;

const result = {
  startedAt: new Date(startedAtMs).toISOString(),
  requestedConcurrency: deviceIds.length,
  sessions: [],
  browser: { processId: 0, debugPort, profileDir },
  error: ""
};

try {
  // Keep every successfully created session immediately so a later 409/error
  // cannot leave any device locked by the load test.
  const creationResults = await Promise.allSettled(deviceIds.map(async (deviceId) => {
    const session = {
      deviceId,
      ...(await request(`/api/v1/user/devices/${encodeURIComponent(deviceId)}/screen-sessions`, {
        method: "POST",
        token,
        body: qualityProfile === "auto" ? undefined : { qualityProfile }
      }))
    };
    created.push(session);
    return session;
  }));
  const creationFailures = creationResults
    .filter((item) => item.status === "rejected")
    .map((item) => String(item.reason?.message || item.reason || "screen_session_create_failed"));
  if (creationFailures.length) throw new Error(`screen_session_create_failed:${creationFailures.join(" | ")}`);
  chrome = spawn(chromePath, [
    "--headless=new",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    `${baseUrl}/`
  ], { stdio: ["ignore", "ignore", "pipe"] });
  result.browser = { processId: chrome.pid || 0, debugPort, profileDir };
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, 15_000);
  for (const item of created) {
    const target = await createTarget(debugPort, `${baseUrl}/`);
    const cdp = await createCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await waitForExpression(cdp, "Boolean(window.PhoneCloudScreenController)", 15_000);
    await evaluate(cdp, createProbeExpression({
        sessionId: item.session.sessionId,
        browserToken: item.browserToken,
        tokenFingerprint: fingerprint(item.browserToken),
        deviceId: item.deviceId,
        media: item.media
    }));
    const probe = { deviceId: item.deviceId, sessionId: item.session.sessionId, cdp };
    probes.push(probe);
    result.sessions.push(probe);
  }

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await Promise.all(result.sessions.map(async (item) => {
      await evaluate(item.cdp, "window.__phoneCloudProbe && window.__phoneCloudProbe.action()");
    }));
    await delay(1_500);
  }
  const snapshots = await Promise.all(result.sessions.map(async (item) => {
    // CDP can discard complex return-by-value objects from an async page
    // function. Serialize explicitly so telemetry never silently becomes {}.
    const response = await evaluate(item.cdp, "window.__phoneCloudProbe ? window.__phoneCloudProbe.snapshot().then((value) => JSON.stringify(value)) : ''");
    const raw = String(response.result?.value || "");
    let snapshot = {};
    try { snapshot = raw ? JSON.parse(raw) : {}; } catch { snapshot = { snapshotParseError: true }; }
    return { deviceId: item.deviceId, sessionId: item.sessionId, ...snapshot };
  }));
  result.sessions = snapshots;
} catch (error) {
  result.error = error?.stack || error?.message || String(error);
} finally {
  await Promise.all(probes.map(async (item) => {
    await evaluate(item.cdp, "window.__phoneCloudProbe && window.__phoneCloudProbe.close()")
      .catch(() => {});
  }));
  await Promise.all(created.map(async (item) => {
    await request(`/api/v1/screen-sessions/${encodeURIComponent(item.session.sessionId)}`, { method: "DELETE", token }).catch(() => {});
  }));
  for (const item of probes) item.cdp?.close();
  chrome?.kill("SIGTERM");
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

for (const item of result.sessions) delete item.cdp;
result.completedAt = new Date().toISOString();
result.durationMs = Date.now() - startedAtMs;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.error ? 1 : 0);

function createProbeExpression({ sessionId, browserToken, tokenFingerprint, deviceId, media }) {
  return `(() => {
    const sessionId = ${JSON.stringify(sessionId)};
    const browserToken = ${JSON.stringify(browserToken)};
    const deviceId = ${JSON.stringify(deviceId)};
    const media = ${JSON.stringify(media || { mode: "websocket" })};
    const video = document.createElement("video");
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.style.cssText = "width:360px;height:760px;position:fixed;left:0;top:0;opacity:0.01";
    document.body.appendChild(video);
    const state = { deviceId, sessionId, tokenFingerprint: ${JSON.stringify(tokenFingerprint)}, statuses: [], metrics: {}, metricSamples: [], actions: 0, actionErrors: [], startedAt: performance.now(), lastMetricSampleAt: -Infinity };
    const controller = new window.PhoneCloudScreenController({
      video,
      onStatus: (item) => state.statuses.push({ atMs: Math.round(performance.now() - state.startedAt), status: item.status, detail: item.detail || "" }),
      onMetrics: (metrics) => {
        state.metrics = { ...metrics, atMs: Math.round(performance.now() - state.startedAt) };
        if (state.metrics.atMs - state.lastMetricSampleAt >= 5000) {
          state.lastMetricSampleAt = state.metrics.atMs;
          state.metricSamples.push({ ...state.metrics });
        }
      }
    });
    let step = 0;
    const fire = (type, x, y) => video.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
    window.__phoneCloudProbe = {
      action() {
        try {
          step += 1;
          controller.key(step % 4 === 1 ? "home" : step % 4 === 2 ? "overview" : "back");
          if (step % 3 === 0) { fire("pointerdown", 180, 570); fire("pointermove", 180, 360); fire("pointerup", 180, 360); }
          if (step % 5 === 0) controller.text("PC");
          state.actions += 1;
        } catch (error) { state.actionErrors.push(String(error?.message || error)); }
      },
      async snapshot() {
        const reports = await controller.player?.pc?.getStats?.();
        const codecs = new Map();
        for (const [id, report] of reports?.entries?.() || []) {
          if (report?.type === "codec") codecs.set(String(report.id || id), report);
        }
        const inboundReports = [];
        const candidates = new Map();
        let selectedCandidatePair = null;
        for (const [id, report] of reports?.entries?.() || []) {
          if (report?.type === "local-candidate" || report?.type === "remote-candidate") {
            candidates.set(String(report.id || id), report);
          }
          if (report?.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded"))) {
            selectedCandidatePair = report;
          }
          const kind = String(report?.kind || report?.mediaType || "").toLowerCase();
          if (report?.type !== "inbound-rtp" || kind !== "video" || report.isRemote) continue;
          const codec = codecs.get(String(report.codecId || ""));
          inboundReports.push({
            id: String(report.id || id), ssrc: String(report.ssrc || ""), codecId: String(report.codecId || ""),
            mimeType: String(codec?.mimeType || ""), bytesReceived: Number(report.bytesReceived || 0),
            packetsReceived: Number(report.packetsReceived || 0), packetsLost: Number(report.packetsLost || 0),
            framesDecoded: Number(report.framesDecoded || 0), framesDropped: Number(report.framesDropped || 0),
            retransmittedPacketsReceived: Number(report.retransmittedPacketsReceived || 0)
          });
        }
        const localCandidate = candidates.get(String(selectedCandidatePair?.localCandidateId || ""));
        const remoteCandidate = candidates.get(String(selectedCandidatePair?.remoteCandidateId || ""));
        const selectedTransport = selectedCandidatePair ? {
          state: String(selectedCandidatePair.state || ""),
          currentRoundTripTimeMs: Math.round(Number(selectedCandidatePair.currentRoundTripTime || 0) * 1000),
          availableOutgoingBitrate: Number(selectedCandidatePair.availableOutgoingBitrate || 0),
          local: localCandidate ? {
            protocol: String(localCandidate.protocol || ""),
            candidateType: String(localCandidate.candidateType || ""),
            address: String(localCandidate.address || localCandidate.ip || ""),
            port: Number(localCandidate.port || 0)
          } : null,
          remote: remoteCandidate ? {
            protocol: String(remoteCandidate.protocol || ""),
            candidateType: String(remoteCandidate.candidateType || ""),
            address: String(remoteCandidate.address || remoteCandidate.ip || ""),
            port: Number(remoteCandidate.port || 0)
          } : null
        } : null;
        return { ...state, statuses: state.statuses.slice(-12), metricSamples: [...state.metricSamples, state.metrics].filter((item) => item && Object.keys(item).length), inboundReports, selectedTransport };
      },
      close() { controller.destroy(); video.remove(); }
    };
    controller.connect({ sessionId, browserToken, media });
    return { ok: true, deviceId, sessionId };
  })()`;
}

async function request(pathname, { method = "GET", token: authToken = "", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${pathname}:${response.status}:${payload.error || payload.detail || text}`);
  return payload;
}

function createCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.once("open", () => resolve({
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { socket.close(); }
    }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (!message.id) return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(`${message.error.code}:${message.error.message}`));
      else item.resolve(message.result || {});
    });
    socket.once("error", reject);
  });
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(`browser_probe_exception:${response.exceptionDetails.text || "runtime_error"}`);
  return response;
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await evaluate(cdp, expression);
    if (response.result?.value) return;
    await delay(150);
  }
  throw new Error(`browser_probe_page_not_ready:${expression}`);
}

function createTarget(port, url) {
  return new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`chrome_debug_unavailable:${lastError?.message || "timeout"}`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fingerprint(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}
