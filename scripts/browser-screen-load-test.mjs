import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { WebSocket } from "ws";

const args = parseArgs(process.argv.slice(2));
const baseUrl = String(args.baseUrl || process.env.PHONE_CLOUD_BASE_URL || "").replace(/\/$/, "");
const username = String(args.username || process.env.PHONE_CLOUD_USERNAME || "admin");
const password = String(process.env.PHONE_CLOUD_PASSWORD || "");
const providedToken = args.tokenStdin
  ? String(await readFile("/dev/stdin", "utf8")).trim()
  : String(process.env.PHONE_CLOUD_TOKEN || "").trim();
const deviceIds = String(args.devices || "").split(",").map((value) => value.trim()).filter(Boolean);
const qualityProfile = String(args.qualityProfile || "auto").trim().toLowerCase();
const durationMs = bounded(args.durationMs, 10_000, 30 * 60_000, 90_000);
const actionIntervalMs = bounded(args.actionIntervalMs, 250, 5_000, 500);
const chromePath = String(args.chromePath || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const debugPort = bounded(args.debugPort, 1024, 65535, 9322);
const profileDir = String(args.profileDir || `/tmp/phone-cloud-browser-probe-${randomUUID()}`);

if (!baseUrl || (!providedToken && !password) || !deviceIds.length) {
  console.error("usage: PHONE_CLOUD_PASSWORD=... node scripts/browser-screen-load-test.mjs --base-url http://host --devices id1,id2 [--duration-ms 90000] (or pipe an existing token with --token-stdin)");
  process.exit(2);
}

const startedAtMs = Date.now();
const token = providedToken || (await request("/api/v1/auth/login", { method: "POST", body: { username, password } })).session.token;
const created = [];
const probes = [];
const chromes = [];
const profileDirs = [];

const result = {
  startedAt: new Date(startedAtMs).toISOString(),
  requestedConcurrency: deviceIds.length,
  sessions: [],
  browsers: [],
  warnings: [],
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
    .map((item, index) => ({ item, deviceId: deviceIds[index] }))
    .filter(({ item }) => item.status === "rejected")
    .map(({ item, deviceId }) => `${deviceId}:${String(item.reason?.message || item.reason || "screen_session_create_failed")}`);
  result.warnings.push(...creationFailures);
  if (!created.length) throw new Error(`screen_session_create_failed:${creationFailures.join(" | ")}`);
  for (let index = 0; index < created.length; index += 1) {
    const item = created[index];
    const browserPort = debugPort + index;
    const browserProfileDir = `${profileDir}-${index}`;
    const chrome = spawn(chromePath, [
      "--headless=new",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${browserPort}`,
      `--user-data-dir=${browserProfileDir}`,
      `${baseUrl}/`
    ], { stdio: ["ignore", "ignore", "pipe"] });
    chromes.push(chrome);
    profileDirs.push(browserProfileDir);
    result.browsers.push({ processId: chrome.pid || 0, debugPort: browserPort, profileDir: browserProfileDir });
    await waitForJson(`http://127.0.0.1:${browserPort}/json/version`, 15_000);
    const target = await createTarget(browserPort, `${baseUrl}/`);
    const cdp = await createCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");
    try {
      await waitForExpression(cdp, "Boolean(window.PhoneCloudScreenController)", 20_000);
    } catch {
      await cdp.send("Page.reload", { ignoreCache: true });
      try {
        await waitForExpression(cdp, "Boolean(window.PhoneCloudScreenController)", 20_000);
      } catch {
        // The production index can occasionally finish without its module
        // script when several isolated Chrome processes start together. Load
        // the probe dependency directly so a page-resource hiccup is not
        // misclassified as a phone/session failure.
        await evaluate(cdp, `import(${JSON.stringify(`${baseUrl}/vendor/screen-control.js?probe=${Date.now()}-${index}`)})`);
        await waitForExpression(cdp, "Boolean(window.PhoneCloudScreenController)", 10_000);
      }
    }
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

  const controllability = await Promise.allSettled(result.sessions.map((item) => waitForExpression(
    item.cdp,
    "Boolean(window.__phoneCloudProbe && window.__phoneCloudProbe.controllable())",
    10_000
  )));
  await Promise.all(result.sessions.map((item, index) => (
    controllability[index]?.status === "fulfilled"
      ? evaluate(item.cdp, "window.__phoneCloudProbe.prime()")
      : Promise.resolve()
  )));
  await delay(750);

  const readiness = await Promise.allSettled(result.sessions.map((item) => waitForExpression(
    item.cdp,
    "Boolean(window.__phoneCloudProbe && window.__phoneCloudProbe.ready())",
    30_000
  )));
  result.sessions.forEach((item, index) => {
    item.ready = readiness[index]?.status === "fulfilled";
    if (!item.ready) {
      item.readinessError = String(readiness[index]?.reason?.message || readiness[index]?.reason || "screen_not_live");
      result.warnings.push(`${item.deviceId}:${item.readinessError}`);
    }
  });
  const activeSessions = result.sessions.filter((item) => item.ready);
  if (!activeSessions.length) throw new Error("browser_probe_no_live_sessions");
  await Promise.all(activeSessions.map((item) => evaluate(
    item.cdp,
    "window.__phoneCloudProbe.prepare()"
  )));
  await delay(1_500);

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await Promise.all(activeSessions.map(async (item) => {
      await evaluate(item.cdp, "window.__phoneCloudProbe && window.__phoneCloudProbe.action()");
    }));
    await delay(actionIntervalMs);
  }
  const snapshots = await Promise.all(result.sessions.map(async (item) => {
    // CDP can discard complex return-by-value objects from an async page
    // function. Serialize explicitly so telemetry never silently becomes {}.
    const response = await evaluate(item.cdp, "window.__phoneCloudProbe ? window.__phoneCloudProbe.snapshot().then((value) => JSON.stringify(value)) : ''");
    const raw = String(response.result?.value || "");
    let snapshot = {};
    try { snapshot = raw ? JSON.parse(raw) : {}; } catch { snapshot = { snapshotParseError: true }; }
    return {
      deviceId: item.deviceId,
      sessionId: item.sessionId,
      ready: item.ready === true,
      ...(item.readinessError ? { readinessError: item.readinessError } : {}),
      ...snapshot
    };
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
  for (const chrome of chromes) chrome?.kill("SIGTERM");
  await Promise.all(profileDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

for (const item of result.sessions) delete item.cdp;
result.completedAt = new Date().toISOString();
result.durationMs = Date.now() - startedAtMs;
const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) await writeFile(String(args.output), serializedResult, "utf8");
process.stdout.write(args.output
  ? `${JSON.stringify({ output: String(args.output), completedAt: result.completedAt, durationMs: result.durationMs, error: result.error, sessions: result.sessions.map(compactSession) }, null, 2)}\n`
  : serializedResult);
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
    const swipe = (direction) => {
      const horizontal = direction === "left" || direction === "right";
      const startX = horizontal ? (direction === "left" ? 300 : 60) : 180;
      const endX = horizontal ? (direction === "left" ? 60 : 300) : 180;
      const startY = horizontal ? 380 : (direction === "up" ? 650 : 110);
      const endY = horizontal ? 380 : (direction === "up" ? 110 : 650);
      fire("pointerdown", startX, startY);
      for (let index = 1; index <= 6; index += 1) {
        fire(
          "pointermove",
          Math.round(startX + (endX - startX) * index / 6),
          Math.round(startY + (endY - startY) * index / 6)
        );
      }
      fire("pointerup", endX, endY);
    };
    window.__phoneCloudProbe = {
      controllable() {
        return state.statuses.some((item) => item.status === "preparing" || item.status === "live");
      },
      ready() {
        return state.statuses.some((item) => item.status === "live");
      },
      prime() {
        controller.key("home");
        setTimeout(() => swipe("up"), 300);
      },
      prepare() {
        controller.key("home");
      },
      action() {
        try {
          step += 1;
          swipe(["left", "right", "up", "down"][(step - 1) % 4]);
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

function compactSession(session = {}) {
  const inbound = Array.isArray(session.inboundReports) ? session.inboundReports[0] || {} : {};
  const metrics = session.metrics || {};
  return {
    deviceId: session.deviceId || "",
    sessionId: session.sessionId || "",
    ready: session.ready === true,
    readinessError: session.readinessError || "",
    actions: Number(session.actions || 0),
    actionErrors: Array.isArray(session.actionErrors) ? session.actionErrors.length : 0,
    statuses: session.statuses || [],
    pageVisibilityState: metrics.pageVisibilityState || "",
    playbackVisible: metrics.playbackVisible === true,
    framesDecoded: Number(inbound.framesDecoded || metrics.rtcFramesDecoded || 0),
    framesDropped: Number(inbound.framesDropped || metrics.rtcFramesDropped || 0),
    packetsLost: Number(inbound.packetsLost || metrics.rtcPacketsLost || 0),
    freezeCount: Number(metrics.rtcFreezeCount || 0),
    totalFreezeMs: Number(metrics.rtcTotalFreezeMs || 0),
    iceRttMs: Number(metrics.rtcIceCurrentRttMs || 0),
    controlRttMs: Number(metrics.controlRttMs || 0)
  };
}
