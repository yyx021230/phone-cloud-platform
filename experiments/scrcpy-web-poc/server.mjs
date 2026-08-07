import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AdbServerClient } from "@yume-chan/adb";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction
} from "@yume-chan/scrcpy";
import { WebSocketServer } from "ws";

const root = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 8792);
const adbPath = process.env.ADB_PATH || "adb";
const configuredSerial = process.env.ANDROID_SERIAL || "";
const serverJar = join(root, "vendor", "scrcpy-server-v3.3.4");
const remoteServerPath = "/data/local/tmp/phone-cloud-scrcpy-server-v3.3.4.jar";
const publicRoot = resolve(root, "dist");

if (!existsSync(serverJar)) {
  throw new Error(`Missing scrcpy server: ${serverJar}`);
}

const sessions = new Map();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store"
  });
  res.end(data);
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

async function serveStatic(url, res) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const candidate = resolve(publicRoot, `.${pathname}`);
  if (!candidate.startsWith(`${publicRoot}/`)) return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const data = await readFile(candidate);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(candidate)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": pathname === "/index.html" ? "no-store" : "public, max-age=3600"
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function listDevices() {
  const { stdout } = await execFileAsync(adbPath, ["devices", "-l"], { timeout: 5000 });
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...parts] = line.split(/\s+/);
      const values = Object.fromEntries(parts.map((part) => {
        const index = part.indexOf(":");
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, ""];
      }));
      return { serial, state, model: values.model || "Android" };
    });
}

function sendStatus(ws, status, detail = "") {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "status", status, detail }));
}

function encodePacket(packet) {
  const header = Buffer.allocUnsafe(10);
  header[0] = packet.type === "configuration" ? 0 : 1;
  header[1] = packet.type === "data" && packet.keyframe ? 1 : 0;
  header.writeBigInt64BE(packet.type === "data" && packet.pts !== undefined ? packet.pts : -1n, 2);
  return Buffer.concat([header, Buffer.from(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength)]);
}

async function createScrcpySession(serial, ws) {
  if (sessions.has(serial)) throw new Error("device_busy");
  const session = { serial, ws, client: null, reader: null, closed: false };
  sessions.set(serial, session);

  try {
    sendStatus(ws, "preparing", "正在推送 scrcpy-server");
    await execFileAsync(adbPath, ["-s", serial, "push", serverJar, remoteServerPath], { timeout: 15000 });

    const connector = new AdbServerNodeTcpConnector({ host: "127.0.0.1", port: 5037 });
    const adbServer = new AdbServerClient(connector);
    const adb = await adbServer.createAdb({ serial });
    const options = new AdbScrcpyOptions3_3_3({
      video: true,
      audio: false,
      control: true,
      tunnelForward: false,
      videoCodec: "h264",
      maxSize: 1600,
      maxFps: 20,
      videoBitRate: 4_000_000,
      sendFrameMeta: true,
      sendDeviceMeta: true,
      sendCodecMeta: true,
      sendDummyByte: true,
      stayAwake: true,
      powerOffOnClose: false,
      clipboardAutosync: false
    }, { version: "3.3.4" });

    sendStatus(ws, "preparing", "正在创建 scrcpy 会话");
    const client = await AdbScrcpyClient.start(adb, remoteServerPath, options);
    session.client = client;
    const video = await client.videoStream;
    ws.send(JSON.stringify({
      type: "metadata",
      codec: video.metadata.codec,
      deviceName: video.metadata.deviceName || serial,
      serial
    }));
    sendStatus(ws, "live", "实时画面已连接");

    const reader = video.stream.getReader();
    session.reader = reader;
    while (!session.closed && ws.readyState === ws.OPEN) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.send(encodePacket(value), { binary: true });
    }
  } finally {
    await closeSession(serial);
  }
}

async function closeSession(serial) {
  const session = sessions.get(serial);
  if (!session) return;
  sessions.delete(serial);
  session.closed = true;
  try { await session.reader?.cancel(); } catch {}
  try { await session.client?.close(); } catch {}
}

async function handleControl(session, message) {
  const controller = session.client?.controller;
  if (!controller) return;
  if (message.type === "touch") {
    const actions = {
      down: AndroidMotionEventAction.Down,
      move: AndroidMotionEventAction.Move,
      up: AndroidMotionEventAction.Up,
      cancel: AndroidMotionEventAction.Cancel
    };
    const action = actions[message.action];
    if (action === undefined) return;
    await controller.injectTouch({
      action,
      pointerId: BigInt(message.pointerId ?? 0),
      pointerX: Math.max(0, Math.round(message.x)),
      pointerY: Math.max(0, Math.round(message.y)),
      videoWidth: Math.max(1, Math.round(message.videoWidth)),
      videoHeight: Math.max(1, Math.round(message.videoHeight)),
      pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
      actionButton: 0,
      buttons: action === AndroidMotionEventAction.Up ? 0 : 1
    });
    return;
  }
  if (message.type === "key") {
    const keyCodes = { back: 4, home: 3, overview: 187 };
    const keyCode = keyCodes[message.key];
    if (!keyCode) return;
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode,
      repeat: 0,
      metaState: 0
    });
    await controller.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode,
      repeat: 0,
      metaState: 0
    });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/devices") {
    try {
      const devices = (await listDevices()).filter((item) => item.state === "device");
      return json(res, 200, { devices, preferredSerial: configuredSerial });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }
  if (await serveStatic(url, res)) return;
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname !== "/stream") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, url));
});

wss.on("connection", (ws, _req, url) => {
  const serial = url.searchParams.get("serial") || configuredSerial;
  if (!serial) {
    sendStatus(ws, "failed", "缺少设备序列号");
    return ws.close(1008, "missing_serial");
  }
  let session;
  ws.on("message", async (data, isBinary) => {
    if (isBinary) return;
    try {
      const message = JSON.parse(data.toString());
      session = sessions.get(serial);
      if (session) await handleControl(session, message);
    } catch (error) {
      sendStatus(ws, "failed", error.message);
    }
  });
  ws.on("close", () => closeSession(serial));
  createScrcpySession(serial, ws).catch((error) => {
    console.error(`[scrcpy:${serial}]`, error?.stack || error);
    if (Array.isArray(error?.output)) console.error(error.output.join("\n"));
    sendStatus(ws, "failed", error.message === "device_busy" ? "设备正在被另一个会话控制" : error.message);
    ws.close(1011, "session_failed");
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Phone Cloud scrcpy POC: http://127.0.0.1:${port}`);
});

async function shutdown() {
  await Promise.all([...sessions.keys()].map(closeSession));
  wss.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
