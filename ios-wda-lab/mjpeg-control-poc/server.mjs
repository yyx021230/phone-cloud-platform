import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clampPoint, createMjpegMetrics, DEFAULT_SESSION_SETTINGS, parseControlPayload } from "./bridge.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 8794);
const wdaBaseUrl = process.env.WDA_BASE_URL || "http://127.0.0.1:8100";
const mjpegUrl = process.env.MJPEG_URL || "http://127.0.0.1:9100";
let session = null;
const mjpegMetrics = createMjpegMetrics();
const boundary = Buffer.from("--BoundaryString");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/mjpeg") return proxyMjpeg(request, response);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url.pathname);
    if (request.method === "GET") return serveStatic(response, url.pathname);
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "server_error" });
  }
});

server.listen(port, host, () => {
  console.log(`iOS WDA MJPEG POC: http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await closeSession().catch(() => {});
    server.close(() => process.exit(0));
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/status") {
    sendJson(response, 200, {
      connected: Boolean(session),
      viewport: session?.viewport || null,
      mjpeg: {
        fps: Number(mjpegMetrics.fpsAt().toFixed(1)),
        frames: mjpegMetrics.frames,
        clients: mjpegMetrics.clients,
        latestFrameAt: mjpegMetrics.latestFrameAt || null,
      },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/debug/source-summary") {
    const current = await ensureSession();
    const source = await wdaJson(`/session/${current.id}/source`, "GET");
    const xml = String(source.value || "");
    const seen = new Set();
    const items = [];
    for (const element of xml.match(/<[^>]+>/g) || []) {
      const label = attr(element, "name") || attr(element, "label") || attr(element, "value");
      const x = Number(attr(element, "x"));
      const y = Number(attr(element, "y"));
      const width = Number(attr(element, "width"));
      const height = Number(attr(element, "height"));
      const value = attr(element, "value");
      if (!label || seen.has(label) || !Number.isFinite(x) || !Number.isFinite(y) || !width || !height) continue;
      seen.add(label);
      items.push({ label, value: value && value !== label ? value : null, x, y, width, height });
      if (items.length >= 30) break;
    }
    sendJson(response, 200, { labels: items.map((item) => item.label), items });
    return;
  }

  if (pathname === "/api/debug/wda-settings") {
    const current = await ensureSession();
    if (request.method === "GET") {
      const settings = await wdaJson(`/session/${current.id}/appium/settings`, "GET");
      sendJson(response, 200, settings.value || settings);
      return;
    }
    if (request.method === "POST") {
      const requested = await readJson(request);
      const settings = pickMjpegSettings(requested);
      await wdaJson(`/session/${current.id}/appium/settings`, "POST", { settings });
      const currentSettings = await wdaJson(`/session/${current.id}/appium/settings`, "GET");
      sendJson(response, 200, currentSettings.value || currentSettings);
      return;
    }
  }

  if (request.method === "POST" && pathname === "/api/connect") {
    const current = await ensureSession();
    await wdaJson(`/session/${current.id}/appium/settings`, "POST", {
      settings: DEFAULT_SESSION_SETTINGS,
    });
    sendJson(response, 200, { connected: true, viewport: current.viewport });
    return;
  }
  if (request.method === "POST" && pathname === "/api/disconnect") {
    await closeSession();
    sendJson(response, 200, { connected: false });
    return;
  }

  if (!["/api/tap", "/api/swipe", "/api/text"].includes(pathname) || request.method !== "POST") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const current = await ensureSession();
  const payload = parseControlPayload(await readJson(request));
  const startedAt = performance.now();
  if (payload.type === "tap") {
    const point = clampPoint(payload.point, current.viewport);
    await wdaJson(`/session/${current.id}/wda/tap`, "POST", point);
  } else if (payload.type === "swipe") {
    const start = clampPoint(payload.start, current.viewport);
    const end = clampPoint(payload.end, current.viewport);
    await wdaJson(`/session/${current.id}/wda/dragfromtoforduration`, "POST", {
      fromX: start.x,
      fromY: start.y,
      toX: end.x,
      toY: end.y,
      duration: payload.durationMs / 1_000,
    });
  } else {
    await wdaJson(`/session/${current.id}/wda/keys`, "POST", { value: [...payload.text] });
  }
  sendJson(response, 200, { ok: true, elapsedMs: Math.round(performance.now() - startedAt) });
}

async function ensureSession() {
  if (session) return session;
  const created = await wdaJson("/session", "POST", {
    capabilities: { alwaysMatch: { bundleId: "com.apple.Preferences" }, firstMatch: [{}] },
  });
  const value = created.value || created;
  const id = created.sessionId || value.sessionId || value.id;
  if (!id) throw new Error("wda_session_not_created");
  const size = await wdaJson(`/session/${id}/window/size`, "GET");
  const viewport = size.value || size;
  session = { id, viewport: { width: Number(viewport.width), height: Number(viewport.height) } };
  return session;
}

async function closeSession() {
  if (!session) return;
  const id = session.id;
  session = null;
  await wdaJson(`/session/${id}`, "DELETE");
}

async function wdaJson(route, method, body) {
  const result = await fetch(`${wdaBaseUrl}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.value?.message || data.error || `wda_http_${result.status}`);
  return data;
}

function proxyMjpeg(request, response) {
  const upstream = http.get(mjpegUrl, (source) => {
    let remainder = Buffer.alloc(0);
    mjpegMetrics.clients += 1;
    source.on("data", (chunk) => {
      const current = Buffer.concat([remainder, chunk]);
      let offset = 0;
      while ((offset = current.indexOf(boundary, offset)) !== -1) {
        mjpegMetrics.recordFrame();
        offset += boundary.length;
      }
      remainder = current.subarray(Math.max(0, current.length - boundary.length + 1));
    });
    source.on("close", () => {
      mjpegMetrics.clients = Math.max(0, mjpegMetrics.clients - 1);
    });
    response.writeHead(source.statusCode || 502, {
      "content-type": source.headers["content-type"] || "multipart/x-mixed-replace",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    source.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) sendJson(response, 502, { error: `mjpeg_unavailable:${error.message}` });
    else response.destroy(error);
  });
  request.on("close", () => upstream.destroy());
}

async function serveStatic(response, pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(directory, `.${normalized}`);
  if (!filePath.startsWith(directory) || !existsSync(filePath)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  response.writeHead(200, { "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream", "cache-control": "no-store" });
  createReadStream(filePath).pipe(response);
}

async function readJson(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function attr(element, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1] || "";
}

function pickMjpegSettings(input) {
  const allowed = new Map([
    ["mjpegServerFramerate", [1, 60]],
    ["mjpegServerScreenshotQuality", [1, 100]],
    ["mjpegScalingFactor", [1, 100]],
    ["waitForIdleTimeout", [0, 10]],
  ]);
  const result = {};
  for (const [key, [minimum, maximum]] of allowed) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`invalid_${key}`);
    result[key] = value;
  }
  if (!Object.keys(result).length) throw new Error("no_supported_settings");
  return result;
}
